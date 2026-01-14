import type { NextApiRequest, NextApiResponse } from "next";
import { AccessToken } from "livekit-server-sdk";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL!;
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;

  if (!LIVEKIT_URL || !apiKey || !apiSecret) {
    res.status(500).json({ error: "Missing LiveKit env vars. Check web/.env.local" });
    return;
  }

  const roomName = (req.query.room as string) || `showroom-${Date.now()}`;
  const userName = (req.query.name as string) || `customer-${Math.floor(Math.random() * 9999)}`;

  // Token for the real user (mic)
  const userToken = new AccessToken(apiKey, apiSecret, { identity: userName });
  userToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  // Token for the local “Avatar” participant (canvas video only)
  const avatarIdentity = "Alex-Avatar";
  const avatarToken = new AccessToken(apiKey, apiSecret, { identity: avatarIdentity });
  avatarToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  res.status(200).json({
    serverUrl: LIVEKIT_URL,
    roomName,
    userToken: await userToken.toJwt(),
    avatarToken: await avatarToken.toJwt()
  });
}
