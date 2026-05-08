import { tag } from "@nacho-smoke/needs-dev-types-a";

export function shout(msg: string): string {
    return tag(msg).toUpperCase();
}
