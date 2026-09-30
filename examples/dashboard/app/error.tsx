"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This screen could not load. If this is the public demo, the database may be waking up. Try again in a few seconds.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Try again
      </button>
    </div>
  );
}
