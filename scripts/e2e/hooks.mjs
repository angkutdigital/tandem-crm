// Node resolve hook: Camp's server actions import next/cache, which only works
// inside a running Next.js request. This test drives the compiled actions
// directly, so revalidatePath is swapped for a no-op.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/cache") {
    return { url: new URL("./next-cache-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
