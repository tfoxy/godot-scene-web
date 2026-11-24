// Adapted from sts2-couch-coop audioUnlock.ts; copyright 2026 Tomás Fox, MIT.
// Called synchronously in the opening gesture, before waiting for the worklet module.
export function playAudioPrelude(): () => void {
  if (typeof document === "undefined") return () => {};
  const bytes = new Uint8Array(44 + 14400 * 2),
    view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  const audio = document.createElement("audio"),
    url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  audio.setAttribute("playsinline", "");
  audio.preload = "auto";
  audio.src = url;
  document.body.appendChild(audio);
  let timer: ReturnType<typeof setTimeout>;
  let done = false;
  const dispose = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    audio.pause();
    audio.removeAttribute("src");
    audio.remove();
    URL.revokeObjectURL(url);
  };
  audio.onended = dispose;
  audio.onerror = dispose;
  timer = setTimeout(dispose, 2000);
  try {
    void audio.play().catch(dispose);
  } catch {
    dispose();
  }
  return dispose;
}
