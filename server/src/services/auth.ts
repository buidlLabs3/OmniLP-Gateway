import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  Address,
  Cell,
  TonClient,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4,
  WalletContractV5R1,
  contractAddress,
  loadStateInit,
  type Slice,
  type StateInit,
} from "@ton/ton";
import { AppError } from "@omnilp/shared";
import nacl from "tweetnacl";
import { verifyMessage } from "viem";
import { z } from "zod";

import type { Config } from "../config.js";
import type { Store } from "../store/types.js";

const proofMaxAgeSeconds = 15 * 60;

const tonProofSchema = z
  .object({
    address: z.string().min(1).max(128),
    network: z.literal("-239"),
    publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/),
    walletStateInit: z.string().min(8).max(50_000),
    proof: z
      .object({
        timestamp: z.coerce.number().int().nonnegative(),
        domain: z
          .object({
            lengthBytes: z.number().int().nonnegative().max(128),
            value: z.string().min(1).max(128),
          })
          .strict(),
        signature: z.string().min(16).max(256),
        payload: z.string().min(16).max(128),
      })
      .strict(),
  })
  .strict();

const baseProofSchema = z
  .object({
    message: z.string().min(16).max(1_000),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();

type TonProofInput = z.infer<typeof tonProofSchema>;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function challengeMessage(
  flowId: string,
  wallet: string,
  nonce: string,
  expiresAt: string,
): string {
  return [
    "OmniLP wallet verification",
    `Flow: ${flowId}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

function loadV1(slice: Slice): Buffer {
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV3(slice: Slice): Buffer {
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV5(slice: Slice): Buffer {
  slice.loadBoolean();
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

const emptyKey = Buffer.alloc(32);
const knownWallets = [
  {
    code: WalletContractV1R1.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV1,
  },
  {
    code: WalletContractV1R2.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV1,
  },
  {
    code: WalletContractV1R3.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV1,
  },
  {
    code: WalletContractV2R1.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV1,
  },
  {
    code: WalletContractV2R2.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV1,
  },
  {
    code: WalletContractV3R1.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV3,
  },
  {
    code: WalletContractV3R2.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV3,
  },
  {
    code: WalletContractV4.create({ workchain: 0, publicKey: emptyKey }).init
      .code,
    load: loadV3,
  },
  {
    code: WalletContractV5R1.create({ publicKey: emptyKey }).init.code,
    load: loadV5,
  },
];

function getStateKey(state: StateInit): Buffer | null {
  if (!state.code || !state.data) return null;
  for (const wallet of knownWallets) {
    try {
      if (wallet.code.equals(state.code))
        return wallet.load(state.data.beginParse());
    } catch {
      continue;
    }
  }
  return null;
}

function tonDigest(address: Address, input: TonProofInput["proof"]): Buffer {
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain);
  const domain = Buffer.from(input.domain.value, "utf8");
  if (input.domain.lengthBytes !== domain.length) {
    throw new AppError(
      "UNAUTHORIZED",
      "TON proof domain length is invalid",
      401,
    );
  }
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(domain.length);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(BigInt(input.timestamp));
  const message = Buffer.concat([
    Buffer.from("ton-proof-item-v2/"),
    workchain,
    address.hash,
    domainLength,
    domain,
    timestamp,
    Buffer.from(input.payload, "utf8"),
  ]);
  const messageHash = createHash("sha256").update(message).digest();
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from([0xff, 0xff]),
        Buffer.from("ton-connect"),
        messageHash,
      ]),
    )
    .digest();
}

export class AuthService {
  private readonly tonClient: TonClient;
  private readonly domain: string;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {
    this.tonClient = new TonClient({ endpoint: config.TON_RPC_URL });
    this.domain = new URL(config.WEB_ORIGIN).host;
  }

  async createChallenge(flowId: string, chain: "base" | "ton") {
    const flow = await this.store.getFlow(flowId);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    const wallet = chain === "base" ? flow.baseWallet : flow.tonWallet;
    const nonce = encode(randomBytes(24));
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const value =
      chain === "base"
        ? challengeMessage(flowId, wallet, nonce, expiresAt)
        : nonce;
    await this.store.saveChallenge({
      flowId,
      chain,
      wallet,
      valueHash: hash(value),
      expiresAt,
    });
    return { chain, value, expiresAt };
  }

  async verifyBase(flowId: string, body: unknown): Promise<void> {
    const input = baseProofSchema.parse(body);
    const flow = await this.store.getFlow(flowId);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    const valid = await verifyMessage({
      address: flow.baseWallet as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
    if (!valid || !input.message.includes(`Flow: ${flowId}`)) {
      throw new AppError("UNAUTHORIZED", "Base wallet proof is invalid", 401);
    }
    const used = await this.store.useChallenge(
      flowId,
      "base",
      flow.baseWallet,
      hash(input.message),
    );
    if (!used)
      throw new AppError(
        "UNAUTHORIZED",
        "Base wallet challenge is invalid or used",
        401,
      );
  }

  async verifyTon(flowId: string, body: unknown): Promise<void> {
    const input = tonProofSchema.parse(body);
    const flow = await this.store.getFlow(flowId);
    if (!flow) throw new AppError("NOT_FOUND", "Flow not found", 404);
    const address = Address.parse(input.address);
    if (
      !Address.parse(flow.tonWallet).equals(address) ||
      input.network !== "-239"
    ) {
      throw new AppError(
        "UNAUTHORIZED",
        "TON wallet or network does not match the flow",
        401,
      );
    }
    if (input.proof.domain.value !== this.domain) {
      throw new AppError(
        "UNAUTHORIZED",
        "TON proof domain does not match",
        401,
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    if (
      input.proof.timestamp > now + 60 ||
      input.proof.timestamp < now - proofMaxAgeSeconds
    ) {
      throw new AppError("UNAUTHORIZED", "TON proof is expired", 401);
    }

    let state: StateInit;
    try {
      state = loadStateInit(
        Cell.fromBase64(input.walletStateInit).beginParse(),
      );
    } catch {
      throw new AppError("UNAUTHORIZED", "TON wallet state is invalid", 401);
    }
    if (!contractAddress(address.workChain, state).equals(address)) {
      throw new AppError(
        "UNAUTHORIZED",
        "TON wallet state does not match the address",
        401,
      );
    }
    let publicKey = getStateKey(state);
    if (!publicKey) {
      try {
        const result = await this.tonClient.runMethod(
          address,
          "get_public_key",
        );
        const key = result.stack.readBigNumber().toString(16).padStart(64, "0");
        publicKey = Buffer.from(key, "hex");
      } catch {
        throw new AppError(
          "UNAUTHORIZED",
          "TON wallet public key could not be verified",
          401,
        );
      }
    }
    const reportedKey = Buffer.from(input.publicKey, "hex");
    if (!timingSafeEqual(publicKey, reportedKey)) {
      throw new AppError(
        "UNAUTHORIZED",
        "TON wallet public key does not match",
        401,
      );
    }
    const signature = Buffer.from(input.proof.signature, "base64");
    if (
      signature.length !== 64 ||
      !nacl.sign.detached.verify(
        tonDigest(address, input.proof),
        signature,
        publicKey,
      )
    ) {
      throw new AppError("UNAUTHORIZED", "TON wallet proof is invalid", 401);
    }
    const used = await this.store.useChallenge(
      flowId,
      "ton",
      flow.tonWallet,
      hash(input.proof.payload),
    );
    if (!used)
      throw new AppError(
        "UNAUTHORIZED",
        "TON wallet challenge is invalid or used",
        401,
      );
  }

  async issueSession(flowId: string): Promise<string> {
    if (!(await this.store.hasWalletProofs(flowId))) {
      throw new AppError(
        "PROOF_REQUIRED",
        "Both wallet proofs are required",
        401,
      );
    }
    const payload = encode(
      JSON.stringify({
        flowId,
        expiresAt: Math.floor(Date.now() / 1_000) + 60 * 60,
      }),
    );
    return `${payload}.${this.sign(payload)}`;
  }

  verifySession(flowId: string, authorization: string | undefined): void {
    if (!authorization?.startsWith("Bearer ")) {
      throw new AppError("UNAUTHORIZED", "Flow session is required", 401);
    }
    const token = authorization.slice(7);
    const [payload, signature, extra] = token.split(".");
    if (
      !payload ||
      !signature ||
      extra ||
      !this.same(signature, this.sign(payload))
    ) {
      throw new AppError("UNAUTHORIZED", "Flow session is invalid", 401);
    }
    let value: { flowId?: unknown; expiresAt?: unknown };
    try {
      value = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as typeof value;
    } catch {
      throw new AppError("UNAUTHORIZED", "Flow session is invalid", 401);
    }
    if (
      value.flowId !== flowId ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw new AppError(
        "UNAUTHORIZED",
        "Flow session is expired or mismatched",
        401,
      );
    }
  }

  private sign(value: string): string {
    return createHmac("sha256", this.config.SESSION_SECRET)
      .update(value)
      .digest("base64url");
  }

  private same(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
