import { useEffect, useMemo, useRef, useState } from "react";
import { LocalVideoTrack, Room, RoomEvent, createLocalAudioTrack } from "livekit-client";

function rmsFromByteTimeDomain(data: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  if ((g as any).roundRect) {
    (g as any).roundRect(x, y, w, h, r);
    return;
  }
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
}

type ConnectionState = "idle" | "connecting" | "live" | "error";

export default function Home() {
  const [state, setState] = useState<ConnectionState>("idle");
  const [status, setStatus] = useState<string>("Idle");
  const [roomName, setRoomName] = useState<string>("");
  const [roomInput, setRoomInput] = useState<string>("");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [agentTalking, setAgentTalking] = useState(false);

  const userRoom = useMemo(() => new Room(), []);
  const avatarRoom = useMemo(() => new Room(), []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(0);
  const voiceLevelRef = useRef(0);
  const mouthRef = useRef(0);
  const blinkRef = useRef({ nextBlink: 0, blinkUntil: 0 });
  const agentTalkingRef = useRef(false);
  const eyeLookRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, nextMove: 0 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const qp = params.get("room");
    const envDefault = process.env.NEXT_PUBLIC_DEFAULT_ROOM;
    const initial = qp || envDefault || "";
    if (initial) {
      setRoomInput(initial);
    }
  }, []);

  async function start() {
    if (state === "connecting" || state === "live") return;

    try {
      setState("connecting");
      setStatus("Connecting to LiveKit...");

      const desiredRoom = (roomInput || "").trim();
      const qs = desiredRoom ? `?room=${encodeURIComponent(desiredRoom)}` : "";
      const r = await fetch(`/api/connection-details${qs}`);
      const { serverUrl, roomName, userToken, avatarToken, error } = await r.json();
      if (error) throw new Error(error);

      setRoomName(roomName);
      setStatus("Joining room and publishing mic...");

      await userRoom.connect(serverUrl, userToken);
      const mic = await createLocalAudioTrack();
      await userRoom.localParticipant.publishTrack(mic);

      setStatus("Spawning interactive avatar...");
      await avatarRoom.connect(serverUrl, avatarToken);

      const canvas = canvasRef.current!;
      const stream = canvas.captureStream(30);
      const [track] = stream.getVideoTracks();
      await avatarRoom.localParticipant.publishTrack(new LocalVideoTrack(track));

      userRoom.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== "audio") return;
        if (participant.identity && participant.identity.startsWith("customer-")) return;

        const el = track.attach() as HTMLAudioElement;
        el.autoplay = true;
        el.volume = 1.0;

        const audioCtx = new AudioContext();
        const src = audioCtx.createMediaElementSource(el);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;

        src.connect(analyser);
        analyser.connect(audioCtx.destination);

        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          const rms = rmsFromByteTimeDomain(buf);
          const open = Math.min(1, Math.max(0, (rms - 0.015) / 0.12));
          const smooth = levelRef.current * 0.8 + open * 0.2;
          levelRef.current = smooth;
          setMouthOpen(smooth);
          setVoiceLevel(smooth);
          requestAnimationFrame(tick);
        };
        tick();
      });

      setState("live");
      setStatus("Live — say hi to Alex");
    } catch (err: any) {
      console.error(err);
      setState("error");
      setStatus(err?.message || "Failed to connect");
    }
  }

  useEffect(() => {
    voiceLevelRef.current = voiceLevel;
    mouthRef.current = mouthOpen;
    const speaking = voiceLevel > 0.08;
    agentTalkingRef.current = speaking;
    setAgentTalking(speaking);
  }, [voiceLevel, mouthOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d")!;
    let raf = 0;

    const drawMouth = (x: number, y: number, w: number, h: number, r: number) => {
      roundRect(g, x, y, w, h, r);
    };

    const draw = (time: number) => {
      const w = canvas.width, h = canvas.height;
      g.clearRect(0, 0, w, h);

      // Sophisticated gradient backdrop with depth
      const bg = g.createRadialGradient(w * 0.5, h * 0.3, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
      bg.addColorStop(0, "#2a1f3d");
      bg.addColorStop(0.4, "#1a1528");
      bg.addColorStop(1, "#0a0612");
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);

      // Ambient light particles
      g.fillStyle = "rgba(139, 92, 246, 0.08)";
      for (let i = 0; i < 15; i++) {
        const px = (i * 73 + time * 0.02) % w;
        const py = (i * 97 + time * 0.015) % h;
        g.beginPath();
        g.arc(px, py, 1.5, 0, Math.PI * 2);
        g.fill();
      }

      const level = voiceLevelRef.current;
      const ringRadius = Math.min(w, h) * 0.35;
      
      // Multi-layer energy rings
      for (let i = 0; i < 3; i++) {
        const offset = i * 15;
        const alpha = 0.15 - i * 0.04 + level * 0.2;
        g.beginPath();
        g.strokeStyle = `rgba(139, 92, 246, ${alpha})`;
        g.lineWidth = 3 - i * 0.8;
        g.arc(w / 2, h / 2, ringRadius + offset + level * 12, 0, Math.PI * 2);
        g.stroke();
      }

      // Pulsing outer glow
      const pulsePhase = Math.sin(time / 1200) * 0.5 + 0.5;
      const outerGlow = g.createRadialGradient(w / 2, h / 2, ringRadius, w / 2, h / 2, ringRadius + 80 + level * 40);
      outerGlow.addColorStop(0, `rgba(124, 58, 237, ${0.5 + level * 0.3 + pulsePhase * 0.15})`);
      outerGlow.addColorStop(0.5, `rgba(99, 102, 241, ${0.25 + level * 0.2})`);
      outerGlow.addColorStop(1, "rgba(59, 130, 246, 0)");
      g.fillStyle = outerGlow;
      g.beginPath();
      g.arc(w / 2, h / 2, ringRadius + 80 + level * 40, 0, Math.PI * 2);
      g.fill();

      // Animated breathing and voice response
      const breathe = 1 + 0.01 * Math.sin(time / 1000);
      const bob = Math.sin(time / 1300) * 2.5 - level * 7;
      const headTilt = Math.sin(time / 2000) * 0.02;
      const headR = Math.min(w, h) * 0.28 * breathe;
      const headX = w / 2;
      const headY = h / 2 + bob;

      g.save();
      g.translate(headX, headY);
      g.rotate(headTilt);
      g.translate(-headX, -headY);

      // Shoulders and neck for more realistic appearance
      const shoulderGrad = g.createLinearGradient(headX - 90, headY + headR, headX + 90, headY + headR * 1.5);
      shoulderGrad.addColorStop(0, "#6b4e7a");
      shoulderGrad.addColorStop(0.5, "#8b5fa8");
      shoulderGrad.addColorStop(1, "#6b4e7a");
      g.fillStyle = shoulderGrad;
      g.beginPath();
      g.ellipse(headX, headY + headR * 1.2, 95, 35, 0, 0, Math.PI);
      g.fill();

      // Neck with proper shading
      const neckGrad = g.createLinearGradient(headX - 45, headY + headR * 0.65, headX + 45, headY + headR * 1.2);
      neckGrad.addColorStop(0, "#f5d5c0");
      neckGrad.addColorStop(0.5, "#fce4d1");
      neckGrad.addColorStop(1, "#ecc8ad");
      g.fillStyle = neckGrad;
      g.beginPath();
      g.moveTo(headX - 38, headY + headR * 0.7);
      g.quadraticCurveTo(headX, headY + headR * 0.85, headX - 32, headY + headR * 1.15);
      g.lineTo(headX + 32, headY + headR * 1.15);
      g.quadraticCurveTo(headX, headY + headR * 0.85, headX + 38, headY + headR * 0.7);
      g.closePath();
      g.fill();

      // Neck shadow
      g.fillStyle = "rgba(210, 180, 140, 0.25)";
      g.beginPath();
      g.ellipse(headX, headY + headR * 0.95, 28, 8, 0, 0, Math.PI);
      g.fill();

      // Enhanced ears with detailed structure
      const earGrad = g.createRadialGradient(headX - headR * 0.95, headY, 5, headX - headR * 0.95, headY, headR * 0.38);
      earGrad.addColorStop(0, "#fce9d8");
      earGrad.addColorStop(0.7, "#f5d5c0");
      earGrad.addColorStop(1, "#e8c4a8");
      g.fillStyle = earGrad;
      g.beginPath();
      g.ellipse(headX - headR * 0.95, headY + 3, headR * 0.32, headR * 0.38, -0.15, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(headX + headR * 0.95, headY + 3, headR * 0.32, headR * 0.38, 0.15, 0, Math.PI * 2);
      g.fill();

      // Inner ear detail
      g.fillStyle = "#d8a888";
      g.beginPath();
      g.ellipse(headX - headR * 0.95, headY + 8, headR * 0.14, headR * 0.18, -0.2, 0, Math.PI * 2);
      g.ellipse(headX + headR * 0.95, headY + 8, headR * 0.14, headR * 0.18, 0.2, 0, Math.PI * 2);
      g.fill();

      // Main head with realistic skin gradient
      const faceGradient = g.createRadialGradient(headX - headR * 0.25, headY - headR * 0.35, headR * 0.15, headX, headY, headR * 1.1);
      faceGradient.addColorStop(0, "#fff5eb");
      faceGradient.addColorStop(0.35, "#ffe8d6");
      faceGradient.addColorStop(0.7, "#f5d5c0");
      faceGradient.addColorStop(1, "#e8c4a8");
      g.fillStyle = faceGradient;
      g.beginPath();
      g.arc(headX, headY, headR, 0, Math.PI * 2);
      g.fill();

      // Subtle face contour and structure
      g.fillStyle = "rgba(220, 180, 150, 0.2)";
      g.beginPath();
      g.ellipse(headX - headR * 0.6, headY + headR * 0.15, headR * 0.28, headR * 0.35, 0.3, 0, Math.PI * 2);
      g.ellipse(headX + headR * 0.6, headY + headR * 0.15, headR * 0.28, headR * 0.35, -0.3, 0, Math.PI * 2);
      g.fill();

      // Jaw shadow for definition
      g.fillStyle = "rgba(210, 170, 140, 0.15)";
      g.beginPath();
      g.ellipse(headX, headY + headR * 0.55, headR * 0.65, headR * 0.25, 0, 0, Math.PI);
      g.fill();

      // Sophisticated hair with volume and layers
      g.fillStyle = "#2d1f3a";
      g.beginPath();
      g.ellipse(headX, headY - headR * 0.15, headR * 1.05, headR * 0.95, 0, 0, Math.PI, true);
      g.fill();

      // Hair volume and highlights
      const hairHighlight = g.createRadialGradient(headX - headR * 0.3, headY - headR * 0.75, 0, headX - headR * 0.3, headY - headR * 0.75, headR * 0.4);
      hairHighlight.addColorStop(0, "rgba(110, 75, 130, 0.6)");
      hairHighlight.addColorStop(1, "rgba(110, 75, 130, 0)");
      g.fillStyle = hairHighlight;
      g.beginPath();
      g.ellipse(headX - headR * 0.35, headY - headR * 0.7, headR * 0.18, headR * 0.38, -0.35, 0, Math.PI * 2);
      g.fill();

      // Hair texture strands
      g.strokeStyle = "rgba(25, 15, 35, 0.35)";
      g.lineWidth = 2.5;
      g.lineCap = "round";
      for (let i = -4; i <= 4; i++) {
        g.beginPath();
        const xOffset = i * headR * 0.22;
        const wave = Math.sin(i * 0.5) * headR * 0.08;
        g.moveTo(headX + xOffset, headY - headR * 0.92);
        g.quadraticCurveTo(headX + xOffset + wave, headY - headR * 0.5, headX + xOffset * 1.1, headY - headR * 0.15);
        g.stroke();
      }

      // Side hair strands
      g.beginPath();
      g.moveTo(headX - headR * 0.9, headY - headR * 0.4);
      g.quadraticCurveTo(headX - headR * 0.95, headY, headX - headR * 0.75, headY + headR * 0.3);
      g.moveTo(headX + headR * 0.9, headY - headR * 0.4);
      g.quadraticCurveTo(headX + headR * 0.95, headY, headX + headR * 0.75, headY + headR * 0.3);
      g.stroke();

      // Eye tracking with subtle movement
      const eyeLook = eyeLookRef.current;
      if (time > eyeLook.nextMove) {
        eyeLook.targetX = (Math.random() - 0.5) * 4;
        eyeLook.targetY = (Math.random() - 0.5) * 3;
        eyeLook.nextMove = time + 1500 + Math.random() * 2500;
      }
      eyeLook.x += (eyeLook.targetX - eyeLook.x) * 0.05;
      eyeLook.y += (eyeLook.targetY - eyeLook.y) * 0.05;

      // Blinking animation
      const blinkState = blinkRef.current;
      if (time > blinkState.nextBlink) {
        blinkState.blinkUntil = time + 140;
        blinkState.nextBlink = time + 3000 + Math.random() * 2500;
      }
      const blink = blinkState.blinkUntil > time ? Math.max(0, (blinkState.blinkUntil - time) / 140) : 0;

      const eyeOffset = headR * 0.40;
      const eyeY = headY - headR * 0.20;

      // Eye whites with subtle detail
      const eyeOpen = 13 * (1 - blink * 0.96);
      const eyeW = 19;
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.ellipse(headX - eyeOffset, eyeY, eyeW, eyeOpen, 0, 0, Math.PI * 2);
      g.ellipse(headX + eyeOffset, eyeY, eyeW, eyeOpen, 0, 0, Math.PI * 2);
      g.fill();

      // Eye shadow on whites for depth
      g.fillStyle = "rgba(200, 200, 210, 0.2)";
      g.beginPath();
      g.ellipse(headX - eyeOffset, eyeY - eyeOpen * 0.3, eyeW * 0.8, eyeOpen * 0.4, 0, 0, Math.PI);
      g.ellipse(headX + eyeOffset, eyeY - eyeOpen * 0.3, eyeW * 0.8, eyeOpen * 0.4, 0, 0, Math.PI);
      g.fill();

      // Detailed iris with depth
      if (blink < 0.8) {
        const irisSize = 11 * (1 - blink * 0.9);
        const irisGrad = g.createRadialGradient(headX - eyeOffset + eyeLook.x, eyeY + eyeLook.y, 1, headX - eyeOffset + eyeLook.x, eyeY + eyeLook.y, irisSize);
        irisGrad.addColorStop(0, "#5eaaf5");
        irisGrad.addColorStop(0.4, "#3b82f6");
        irisGrad.addColorStop(0.7, "#2563eb");
        irisGrad.addColorStop(1, "#1e40af");
        g.fillStyle = irisGrad;
        g.beginPath();
        g.arc(headX - eyeOffset + eyeLook.x, eyeY + eyeLook.y, irisSize, 0, Math.PI * 2);
        g.arc(headX + eyeOffset + eyeLook.x, eyeY + eyeLook.y, irisSize, 0, Math.PI * 2);
        g.fill();

        // Iris detail ring
        g.strokeStyle = "rgba(30, 60, 140, 0.4)";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(headX - eyeOffset + eyeLook.x, eyeY + eyeLook.y, irisSize * 0.7, 0, Math.PI * 2);
        g.arc(headX + eyeOffset + eyeLook.x, eyeY + eyeLook.y, irisSize * 0.7, 0, Math.PI * 2);
        g.stroke();

        // Pupils
        g.fillStyle = "#0a0f1e";
        const pupilSize = 5.5 * (1 - blink * 0.9);
        g.beginPath();
        g.arc(headX - eyeOffset + eyeLook.x + 0.5, eyeY + eyeLook.y + 0.5, pupilSize, 0, Math.PI * 2);
        g.arc(headX + eyeOffset + eyeLook.x + 0.5, eyeY + eyeLook.y + 0.5, pupilSize, 0, Math.PI * 2);
        g.fill();

        // Eye highlights (main and secondary)
        g.fillStyle = "rgba(255, 255, 255, 0.9)";
        g.beginPath();
        g.arc(headX - eyeOffset - 2.5 + eyeLook.x * 0.3, eyeY - 2.5 + eyeLook.y * 0.3, 3.5 * (1 - blink), 0, Math.PI * 2);
        g.arc(headX + eyeOffset - 2.5 + eyeLook.x * 0.3, eyeY - 2.5 + eyeLook.y * 0.3, 3.5 * (1 - blink), 0, Math.PI * 2);
        g.fill();

        g.fillStyle = "rgba(255, 255, 255, 0.5)";
        g.beginPath();
        g.arc(headX - eyeOffset + 3.5 + eyeLook.x * 0.3, eyeY + 2.5 + eyeLook.y * 0.3, 1.8 * (1 - blink), 0, Math.PI * 2);
        g.arc(headX + eyeOffset + 3.5 + eyeLook.x * 0.3, eyeY + 2.5 + eyeLook.y * 0.3, 1.8 * (1 - blink), 0, Math.PI * 2);
        g.fill();
      }

      // Upper eyelids
      g.strokeStyle = "#2d1f3a";
      g.lineWidth = 2.5;
      g.lineCap = "round";
      g.beginPath();
      g.ellipse(headX - eyeOffset, eyeY, eyeW, eyeOpen + 2, 0, Math.PI, 0, true);
      g.ellipse(headX + eyeOffset, eyeY, eyeW, eyeOpen + 2, 0, Math.PI, 0, true);
      g.stroke();

      // Eyelashes
      g.strokeStyle = "rgba(45, 31, 58, 0.8)";
      g.lineWidth = 1.5;
      for (let i = 0; i < 5; i++) {
        const angle = (i - 2) * 0.15;
        const lashLen = 6 + (i === 2 ? 2 : 0);
        
        // Left eye lashes
        g.beginPath();
        g.moveTo(headX - eyeOffset + Math.cos(Math.PI + angle) * eyeW, eyeY - Math.sin(angle) * eyeOpen);
        g.lineTo(headX - eyeOffset + Math.cos(Math.PI + angle) * (eyeW + lashLen), eyeY - Math.sin(angle) * (eyeOpen + lashLen * 0.7));
        g.stroke();
        
        // Right eye lashes
        g.beginPath();
        g.moveTo(headX + eyeOffset + Math.cos(angle) * eyeW, eyeY - Math.sin(angle) * eyeOpen);
        g.lineTo(headX + eyeOffset + Math.cos(angle) * (eyeW + lashLen), eyeY - Math.sin(angle) * (eyeOpen + lashLen * 0.7));
        g.stroke();
      }

      // Expressive eyebrows with natural curve
      g.strokeStyle = "#2d1f3a";
      g.lineWidth = 3.5;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.beginPath();
      g.moveTo(headX - eyeOffset - 13, headY - headR * 0.36);
      g.quadraticCurveTo(headX - eyeOffset - 3, headY - headR * 0.40, headX - eyeOffset + 10, headY - headR * 0.37);
      g.moveTo(headX + eyeOffset - 10, headY - headR * 0.37);
      g.quadraticCurveTo(headX + eyeOffset + 3, headY - headR * 0.40, headX + eyeOffset + 13, headY - headR * 0.36);
      g.stroke();

      // Refined nose with proper shading
      const noseGrad = g.createLinearGradient(headX - 8, headY - headR * 0.02, headX + 8, headY + headR * 0.14);
      noseGrad.addColorStop(0, "#f5d5c0");
      noseGrad.addColorStop(1, "#e8c4a8");
      g.fillStyle = noseGrad;
      g.beginPath();
      g.moveTo(headX, headY + headR * 0.01);
      g.quadraticCurveTo(headX - 4, headY + headR * 0.05, headX - 8, headY + headR * 0.13);
      g.lineTo(headX + 8, headY + headR * 0.13);
      g.quadraticCurveTo(headX + 4, headY + headR * 0.05, headX, headY + headR * 0.01);
      g.closePath();
      g.fill();

      // Nose highlight
      g.fillStyle = "rgba(255, 255, 255, 0.35)";
      g.beginPath();
      g.moveTo(headX - 1.5, headY + headR * 0.03);
      g.lineTo(headX + 1, headY + headR * 0.03);
      g.lineTo(headX, headY + headR * 0.10);
      g.closePath();
      g.fill();

      // Nostrils
      g.fillStyle = "rgba(200, 160, 130, 0.5)";
      g.beginPath();
      g.ellipse(headX - 6, headY + headR * 0.13, 2.5, 1.8, 0.3, 0, Math.PI * 2);
      g.ellipse(headX + 6, headY + headR * 0.13, 2.5, 1.8, -0.3, 0, Math.PI * 2);
      g.fill();

      // Natural rosy cheeks
      const cheekGrad = g.createRadialGradient(headX - eyeOffset, headY + headR * 0.10, 0, headX - eyeOffset, headY + headR * 0.10, 20);
      cheekGrad.addColorStop(0, "rgba(255, 130, 150, 0.45)");
      cheekGrad.addColorStop(0.6, "rgba(255, 130, 150, 0.25)");
      cheekGrad.addColorStop(1, "rgba(255, 130, 150, 0)");
      g.fillStyle = cheekGrad;
      g.beginPath();
      g.arc(headX - eyeOffset, headY + headR * 0.10, 20, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(headX + eyeOffset, headY + headR * 0.10, 20, 0, Math.PI * 2);
      g.fill();

      // Enhanced animated mouth
      const mouthW = headR * 1.10;
      const mouthH = 10 + mouthRef.current * 70;
      const mouthY = headY + headR * 0.40;
      
      // Mouth outline
      g.beginPath();
      drawMouth(headX - mouthW / 2, mouthY, mouthW, mouthH, 20);
      const mouthGrad = g.createLinearGradient(headX, mouthY, headX, mouthY + mouthH);
      mouthGrad.addColorStop(0, "#4a2639");
      mouthGrad.addColorStop(1, "#2d1621");
      g.fillStyle = mouthGrad;
      g.fill();
      
      // Upper teeth with realistic detail
      if (mouthRef.current > 0.12) {
        g.fillStyle = "#fefefe";
        const teethW = mouthW * 0.70;
        const teethH = Math.min(mouthH * 0.28, 20);
        drawMouth(headX - teethW / 2, mouthY + 2, teethW, teethH, 5);
        g.fill();
        
        // Teeth separation and detail
        g.strokeStyle = "rgba(235, 235, 240, 0.6)";
        g.lineWidth = 1.2;
        for (let i = 1; i < 6; i++) {
          const tx = headX - teethW / 2 + (teethW / 6) * i;
          g.beginPath();
          g.moveTo(tx, mouthY + 3);
          g.lineTo(tx, mouthY + teethH);
          g.stroke();
        }
        
        // Gum line
        g.strokeStyle = "rgba(255, 180, 180, 0.3)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(headX - teethW / 2, mouthY + 2);
        g.lineTo(headX + teethW / 2, mouthY + 2);
        g.stroke();
      }
      
      // Lower teeth when mouth is very open
      if (mouthRef.current > 0.5) {
        g.fillStyle = "#fafafa";
        const lowerTeethW = mouthW * 0.65;
        const lowerTeethH = Math.min(mouthH * 0.20, 14);
        drawMouth(headX - lowerTeethW / 2, mouthY + mouthH - lowerTeethH - 2, lowerTeethW, lowerTeethH, 5);
        g.fill();
        
        g.strokeStyle = "rgba(230, 230, 235, 0.5)";
        g.lineWidth = 1;
        for (let i = 1; i < 5; i++) {
          const tx = headX - lowerTeethW / 2 + (lowerTeethW / 5) * i;
          g.beginPath();
          g.moveTo(tx, mouthY + mouthH - lowerTeethH - 2);
          g.lineTo(tx, mouthY + mouthH - 2);
          g.stroke();
        }
      }
      
      // Realistic tongue
      if (mouthRef.current > 0.25) {
        const tongueGrad = g.createRadialGradient(headX, mouthY + mouthH * 0.6, 5, headX, mouthY + mouthH * 0.65, mouthW * 0.35);
        tongueGrad.addColorStop(0, "#ff7a94");
        tongueGrad.addColorStop(0.6, "#f43f5e");
        tongueGrad.addColorStop(1, "#e11d48");
        g.fillStyle = tongueGrad;
        drawMouth(headX - mouthW * 0.28, mouthY + mouthH * 0.50, mouthW * 0.56, mouthH * 0.42, 14);
        g.fill();
        
        // Tongue texture
        g.fillStyle = "rgba(220, 80, 100, 0.2)";
        g.beginPath();
        g.ellipse(headX, mouthY + mouthH * 0.68, mouthW * 0.15, mouthH * 0.12, 0, 0, Math.PI * 2);
        g.fill();
      }

      // Upper lip definition
      g.strokeStyle = "rgba(210, 150, 130, 0.4)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(headX - mouthW * 0.45, mouthY);
      g.quadraticCurveTo(headX, mouthY - 2, headX + mouthW * 0.45, mouthY);
      g.stroke();

      g.restore(); // Restore rotation

      // Advanced waveform visualization with spectrum analyzer feel
      const bars = 40;
      const barSpace = w / bars;
      const barGap = 4;
      
      for (let i = 0; i < bars; i++) {
        const t = time / 320 + i * 0.45;
        const wave1 = Math.sin(t);
        const wave2 = Math.sin(t * 1.5 + Math.PI / 3);
        const wave3 = Math.sin(t * 0.8 + Math.PI / 2);
        const combined = (wave1 + wave2 + wave3) / 3;
        const jitter = (combined + 1) / 2;
        const baseHeight = 10;
        const hgt = baseHeight + (level * 55 + jitter * 32);
        
        const barX = i * barSpace + barGap;
        const barW = barSpace - barGap * 2;
        
        // Bar gradient
        const barGrad = g.createLinearGradient(barX, h - hgt - 20, barX, h - 20);
        barGrad.addColorStop(0, `rgba(167, 139, 250, ${0.8 + level * 0.2})`);
        barGrad.addColorStop(0.5, `rgba(139, 92, 246, ${0.6 + level * 0.3})`);
        barGrad.addColorStop(1, `rgba(99, 102, 241, ${0.4 + level * 0.2})`);
        g.fillStyle = barGrad;
        
        // Rounded bar
        g.beginPath();
        roundRect(g, barX, h - hgt - 20, barW, hgt, 2);
        g.fill();
        
        // Bar highlight
        const highlightGrad = g.createLinearGradient(barX, h - hgt - 20, barX, h - hgt - 20 + hgt * 0.3);
        highlightGrad.addColorStop(0, "rgba(255, 255, 255, 0.3)");
        highlightGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
        g.fillStyle = highlightGrad;
        g.beginPath();
        roundRect(g, barX, h - hgt - 20, barW, hgt * 0.3, 2);
        g.fill();
      }

      // Enhanced status chip with glassmorphism
      const agentIsSpeaking = agentTalkingRef.current;
      
      // Chip background with blur effect simulation
      const chipGrad = g.createLinearGradient(16, 16, 16, 52);
      chipGrad.addColorStop(0, "rgba(45, 31, 58, 0.85)");
      chipGrad.addColorStop(1, "rgba(20, 15, 30, 0.90)");
      g.fillStyle = chipGrad;
      roundRect(g, 16, 16, 175, 40, 12);
      g.fill();
      
      // Chip border with glow
      g.strokeStyle = agentIsSpeaking ? "rgba(34, 197, 94, 0.6)" : "rgba(139, 92, 246, 0.5)";
      g.lineWidth = 2;
      roundRect(g, 16, 16, 175, 40, 12);
      g.stroke();
      
      // Inner highlight
      g.strokeStyle = "rgba(255, 255, 255, 0.1)";
      g.lineWidth = 1;
      roundRect(g, 17, 17, 173, 38, 11);
      g.stroke();
      
      // Status indicator dot
      const dotGrad = g.createRadialGradient(32, 36, 0, 32, 36, 6);
      if (agentIsSpeaking) {
        dotGrad.addColorStop(0, "#4ade80");
        dotGrad.addColorStop(1, "#22c55e");
      } else {
        dotGrad.addColorStop(0, "#a78bfa");
        dotGrad.addColorStop(1, "#8b5cf6");
      }
      g.fillStyle = dotGrad;
      g.beginPath();
      g.arc(32, 36, 5, 0, Math.PI * 2);
      g.fill();
      
      // Dot pulse
      if (agentIsSpeaking) {
        const pulse = Math.sin(time / 300) * 0.5 + 0.5;
        g.strokeStyle = `rgba(34, 197, 94, ${0.4 * pulse})`;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(32, 36, 7 + pulse * 3, 0, Math.PI * 2);
        g.stroke();
      }
      
      // Label text
      g.fillStyle = "#f1f5f9";
      g.font = "600 15px 'Inter', 'Segoe UI', sans-serif";
      g.fillText(agentIsSpeaking ? "Alex · Speaking" : "Alex · Listening", 48, 40);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "40px 24px 56px",
        background: "radial-gradient(circle at 25% 15%, #2a1f3d, #1a1528 40%, #0a0612)",
        color: "#e2e8f0",
        fontFamily: "'Inter', 'Segoe UI', -apple-system, sans-serif",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 1200 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
          <div>
            <div style={{ 
              display: "inline-flex", 
              alignItems: "center", 
              gap: 10, 
              padding: "8px 14px", 
              background: "rgba(139,92,246,0.12)", 
              borderRadius: 14, 
              border: "1.5px solid rgba(139,92,246,0.35)",
              boxShadow: "0 4px 12px rgba(139,92,246,0.15)"
            }}>
              <span style={{ 
                width: 9, 
                height: 9, 
                borderRadius: 999, 
                background: state === "live" ? "#22c55e" : "#fbbf24",
                boxShadow: state === "live" ? "0 0 8px rgba(34,197,94,0.6)" : "0 0 8px rgba(251,191,36,0.6)"
              }} />
              <span style={{ fontSize: 13, letterSpacing: 0.5, fontWeight: 500 }}>LiveKit Voice Agent</span>
            </div>
            <h1 style={{ 
              margin: "16px 0 6px", 
              fontSize: 36, 
              fontWeight: 700,
              background: "linear-gradient(135deg, #f8fafc, #cbd5e1)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text"
            }}>
              EcoBike X1 Virtual Showroom
            </h1>
            <p style={{ margin: 0, color: "#cbd5e1", fontSize: 15, lineHeight: 1.6 }}>
              Meet Alex, your AI product expert. Speak into your mic and watch the avatar respond in real time.
            </p>
          </div>
          <div style={{ 
            textAlign: "right",
            padding: "12px 18px",
            background: "rgba(30,41,59,0.6)",
            borderRadius: 12,
            border: "1px solid rgba(148,163,184,0.2)"
          }}>
            <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 }}>Room</div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{roomName || roomInput || "Not connected"}</div>
          </div>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)",
            gap: 20,
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              background: "linear-gradient(145deg, rgba(45,31,58,0.75), rgba(20,15,30,0.85))",
              border: "1.5px solid rgba(139,92,246,0.3)",
              borderRadius: 20,
              padding: 20,
              position: "relative",
              overflow: "hidden",
              boxShadow: "0 25px 70px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          >
            <div style={{ 
              position: "absolute", 
              inset: 0, 
              pointerEvents: "none", 
              background: "radial-gradient(circle at 35% 25%, rgba(139,92,246,0.15), transparent 40%)",
              mixBlendMode: "screen"
            }} />
            
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, position: "relative", zIndex: 1 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ 
                  padding: "7px 12px", 
                  background: "rgba(139,92,246,0.15)", 
                  borderRadius: 11, 
                  border: "1px solid rgba(139,92,246,0.35)", 
                  fontSize: 13,
                  fontWeight: 500
                }}>
                  Avatar Stream
                </span>
                <span style={{ color: "#94a3b8", fontSize: 13 }}>
                  {state === "live" ? "Interactive · Responsive" : status}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>Status:</span>
                <span style={{ 
                  fontWeight: 600, 
                  fontSize: 13,
                  color: state === "live" ? "#22c55e" : "#f8fafc" 
                }}>
                  {status}
                </span>
              </div>
            </div>

            <div
              style={{
                position: "relative",
                borderRadius: 16,
                overflow: "hidden",
                border: "2px solid rgba(148,163,184,0.2)",
                boxShadow: "0 8px 32px rgba(0,0,0,0.3)"
              }}
            >
              <canvas
                ref={canvasRef}
                width={600}
                height={420}
                style={{ display: "block", width: "100%", height: "auto" }}
              />
              <div style={{ 
                position: "absolute", 
                left: 18, 
                bottom: 18, 
                display: "flex", 
                gap: 12, 
                alignItems: "center",
                background: "rgba(15,23,42,0.85)",
                padding: "8px 14px",
                borderRadius: 10,
                border: "1px solid rgba(148,163,184,0.2)",
                backdropFilter: "blur(8px)"
              }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 999,
                    background: agentTalking ? "#22c55e" : "#8b5cf6",
                    boxShadow: agentTalking ? "0 0 14px rgba(34,197,94,0.7)" : "0 0 14px rgba(139,92,246,0.6)",
                  }}
                />
                <div style={{ fontSize: 13, color: "#e2e8f0", fontWeight: 500 }}>
                  {agentTalking ? "Alex is responding" : state === "live" ? "Listening..." : "Avatar idle"}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              background: "rgba(20,15,30,0.75)",
              border: "1.5px solid rgba(148,163,184,0.2)",
              borderRadius: 20,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Talk to Alex</h3>
              <div
                style={{
                  padding: "7px 12px",
                  background: "rgba(139,92,246,0.15)",
                  border: "1px solid rgba(139,92,246,0.35)",
                  borderRadius: 11,
                  fontSize: 12,
                  color: "#c4b5fd",
                  fontWeight: 500
                }}
              >
                Voice-first
              </div>
            </div>

            <p style={{ margin: 0, color: "#cbd5e1", lineHeight: 1.6, fontSize: 14 }}>
              Hit connect and speak normally. The agent streams audio both ways; the avatar lip-syncs to the AI voice.
              You can interrupt at any time—Alex will adapt and re-route the conversation.
            </p>

            <label style={{ display: "block", marginTop: 8, color: "#94a3b8", fontSize: 13, fontWeight: 500 }}>
              Room name (must match the Python agent room):
            </label>
            <input
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              placeholder="e.g. showroom-demo"
              style={{
                marginTop: 6,
                padding: "11px 14px",
                borderRadius: 11,
                border: "1.5px solid rgba(148,163,184,0.3)",
                background: "rgba(15,23,42,0.5)",
                color: "#e2e8f0",
                width: "100%",
                outline: "none",
                fontSize: 14,
                transition: "all 0.2s"
              }}
              onFocus={(e) => e.target.style.borderColor = "rgba(139,92,246,0.6)"}
              onBlur={(e) => e.target.style.borderColor = "rgba(148,163,184,0.3)"}
            />

            <button
              onClick={start}
              disabled={state === "connecting" || state === "live"}
              style={{
                marginTop: 6,
                padding: "13px 16px",
                borderRadius: 13,
                border: state === "live" ? "1.5px solid rgba(34,197,94,0.4)" : "1.5px solid rgba(139,92,246,0.5)",
                background: state === "live" 
                  ? "rgba(34,197,94,0.15)" 
                  : "linear-gradient(135deg, #8b5cf6, #7c3aed)",
                color: "#f8fafc",
                fontWeight: 600,
                fontSize: 14,
                cursor: state === "live" ? "default" : "pointer",
                boxShadow: state === "live" 
                  ? "0 8px 24px rgba(34,197,94,0.25)" 
                  : "0 12px 40px rgba(139,92,246,0.4)",
                transition: "all 0.3s"
              }}
            >
              {state === "live" ? "✓ Connected — start talking" : state === "connecting" ? "Connecting..." : "Connect & Talk"}
            </button>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                gap: 14,
                marginTop: 6
              }}
            >
              <div style={{ 
                padding: 14, 
                borderRadius: 13, 
                background: "rgba(139,92,246,0.08)", 
                border: "1px solid rgba(139,92,246,0.25)" 
              }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Try saying</div>
                <ul style={{ margin: "0 0 0 18px", padding: 0, color: "#cbd5e1", lineHeight: 1.7, fontSize: 13 }}>
                  <li>"Does this bike have GPS?"</li>
                  <li>"What's the battery range?"</li>
                  <li>"How long does shipping take?"</li>
                  <li>"I want to buy one."</li>
                </ul>
              </div>
              <div style={{ 
                padding: 14, 
                borderRadius: 13, 
                background: "rgba(16,185,129,0.08)", 
                border: "1px solid rgba(16,185,129,0.25)" 
              }}>
                <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Tips</div>
                <ul style={{ margin: "0 0 0 18px", padding: 0, color: "#cbd5e1", lineHeight: 1.7, fontSize: 13 }}>
                  <li>Stay unmuted; Alex adapts mid-sentence.</li>
                  <li>Check mic permissions if no motion.</li>
                  <li>Run Python agent for voice track.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}