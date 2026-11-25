import { writeFileSync } from "node:fs";

export default class UserReporter {
  onTestRunEnd() {
    writeFileSync(
      new URL("../maintenance-root/user-reporter.log", import.meta.url),
      "ended\n",
    );
  }
}
