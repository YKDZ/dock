export const marker = "🚀";

export class Service {
  value = "service";

  run(input: string) {
    return input;
  }
}

export interface Contract {
  value: string;
  run(input: string): string;
}

export type Output = string;

export function calculate(input: number): number {
  return input + 1;
}
