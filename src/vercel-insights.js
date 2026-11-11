import { inject } from "@vercel/analytics";
import { injectSpeedInsights } from "@vercel/speed-insights";

if (import.meta.env.PROD) {
  inject({ mode: "production" });
  injectSpeedInsights();
}
