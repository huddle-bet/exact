export async function readAsset(implementation, base, path) {
  if (implementation?.asset) {
    const bytes = await implementation.asset(path);
    if (bytes != null) return bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const res = await fetch(new URL(path, base));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.arrayBuffer();
}
