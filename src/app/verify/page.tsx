import { Suspense } from "react";
import VerifyLandingClient from "./landing-client";

export default function VerifyLandingPage() {
  return (
    <Suspense fallback={null}>
      <VerifyLandingClient />
    </Suspense>
  );
}
