import { aroundEach } from "vitest";

import { installVitestAttemptCapture } from "./attempt-context.ts";

installVitestAttemptCapture(aroundEach);
