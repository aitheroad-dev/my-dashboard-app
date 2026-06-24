import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "My Dashboard" },
    {
      name: "description",
      content: "Your personal dashboard — your own isolated fork.",
    },
  ];
}

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-3xl font-semibold text-gray-900">My Dashboard</h1>
      <p className="max-w-md text-gray-600">
        Your own isolated fork is live. Pages, settings, and the assistant
        arrive next.
      </p>
      <a
        href="/api/health"
        className="rounded bg-gray-100 px-3 py-1 font-mono text-sm text-gray-700 hover:bg-gray-200"
      >
        /api/health
      </a>
    </main>
  );
}
