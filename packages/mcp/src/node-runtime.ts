export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 22) throw new Error("RT_NODE_VERSION_UNSUPPORTED:Node.js 22 or newer is required");
}
