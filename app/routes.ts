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
  ]),
] satisfies RouteConfig;
