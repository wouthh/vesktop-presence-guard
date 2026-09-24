/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Status } from "./types";
export class WriteCancelledBeforeMutation extends Error {
    constructor() { super("cancelled_before_local_write"); this.name = "WriteCancelledBeforeMutation"; }
}

export function statusMutator(target: Status, guard: () => boolean) {
    return (draft: any) => {
        if (!guard()) throw new WriteCancelledBeforeMutation();
        if (!draft?.status || typeof draft.status.value !== "string") throw Error("status_shape_unknown");
        draft.status.value = target;
    };
}
