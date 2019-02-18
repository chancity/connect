/* @flow */
'use strict';

import AbstractMethod from './AbstractMethod';
import * as UI from '../../constants/ui';
import { validateParams } from './helpers/paramsValidator';

import type { CoreMessage } from '../../types';

type Params = {
    payload: string,
    hash?: string,
}

export default class FirmwareUpload extends AbstractMethod {
    params: Params;
    run: () => Promise<any>;

    constructor(message: CoreMessage) {
        super(message);
        this.useUi = false;

        const payload: Object = message.payload;

        validateParams(payload, [
            { name: 'payload', type: 'array buffer', obligatory: true },
            { name: 'hash', type: 'string' },
        ]);

        this.params = {
            payload: payload.payload,
        };

        this.allowDeviceMode = [...this.allowDeviceMode, UI.BOOTLOADER, UI.INITIALIZE];
        this.useDeviceState = false;
    }

    async run(): Promise<Object> {
        return await this.device.getCommands().firmwareUpload(this.params);
    }
}
