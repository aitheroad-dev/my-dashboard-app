import { LineChart } from "lucide-react";
import type { Route } from "./+types/portfolio";
import { usePortfolio, useRequireEnabled } from "../lib/api";
import {
  PageHeader,
  EmptyState,
  Loading,
  ErrorState,
} from "../components/ui";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Portfolio — My Dashboard" }];
}

export default function Portfolio() {
  useRequireEnabled("portfolio");
  const { data, isLoading, error } = usePortfolio();

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle="Your holdings, valued in one base currency."
      />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : !data || !data.configured || data.holdings.length === 0 ? (
        <EmptyState
          icon={LineChart}
          title="No portfolio connected"
          message="Once you connect your holdings, you’ll see total value, per-currency and per-cluster breakdowns here."
        />
      ) : null}
    </div>
  );
}
