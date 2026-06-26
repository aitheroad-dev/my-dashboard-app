import {
  type RouteConfig,
  index,
  route,
  layout,
} from "@react-router/dev/routes";

export default [
  layout("components/Shell.tsx", [
    index("routes/home.tsx"),
    route("projects", "routes/projects.tsx"),
    route("goals", "routes/goals.tsx"),
    route("portfolio", "routes/portfolio.tsx"),
    route("tools", "routes/tools.tsx"),
    route("kb", "routes/kb.tsx"),
    route("kb-doc/:slug", "routes/kb-doc.tsx"),
    route("assistant", "routes/assistant.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
