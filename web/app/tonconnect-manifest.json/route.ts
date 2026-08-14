import { type NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto") ??
    request.nextUrl.protocol.replace(":", "");
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ??
    (host ? `${protocol}://${host}` : request.nextUrl.origin)
  ).replace(/\/$/, "");
  return NextResponse.json(
    {
      url: appUrl,
      name: "OmniLP Gateway",
      iconUrl: `${appUrl}/tonconnect-icon`,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
