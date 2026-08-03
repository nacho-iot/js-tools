import { mixed } from "./mixed-g.js";

export type Unused = string;

export function helper() {
    return typeof mixed === "function" ? "h" : "?";
}
