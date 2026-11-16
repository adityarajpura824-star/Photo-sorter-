// Is this running inside the Android app (Capacitor), or in an ordinary browser (testing)?
export const cap = () => globalThis.Capacitor;
export function isNative() {
  const c = cap();
  try {
    if (!c) return false;
    if (typeof c.isNativePlatform === "function") return !!c.isNativePlatform();
    if (typeof c.getPlatform === "function") return c.getPlatform() !== "web";
  } catch { /* fall through */ }
  return false;
}
export const plugin = name => cap().Plugins?.[name] || cap().registerPlugin(name);
