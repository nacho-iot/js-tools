import { fromB } from "./value-b.js";

export function fromA() {
    return `a:${fromB()}`;
}
