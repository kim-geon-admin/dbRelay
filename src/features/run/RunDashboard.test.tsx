import { render, screen } from "@testing-library/react";
import { RunDashboard } from "./RunDashboard";
import type { Run } from "./run.types";

const rolledBackRun: Run = {
  runId: "run-2",
  policy: "all_or_nothing",
  status: "rolled_back",
  steps: ["failed"],
  events: [],
};

it("does not render recovery controls for an all-or-nothing failure", () => {
  render(<RunDashboard run={rolledBackRun} />);

  expect(screen.queryByRole("button", { name: /edit and retry/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /skip and continue/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();
});
