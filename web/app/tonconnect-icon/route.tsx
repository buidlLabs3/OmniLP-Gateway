import { ImageResponse } from "next/og";

export function GET() {
  return new ImageResponse(
    <div
      style={{
        width: "180px",
        height: "180px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#171917",
        color: "#f4ca3c",
        fontSize: "64px",
        fontWeight: 800,
      }}
    >
      OL
    </div>,
    {
      width: 180,
      height: 180,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
}
