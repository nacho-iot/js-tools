import { fromL } from "./texp-l.js";

export interface KType {
    value: string;
}

export function fromK() {
    return fromL();
}
