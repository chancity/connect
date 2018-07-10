/* @flow */
'use strict';

import AbstractMethod from './AbstractMethod';
import Discovery from './helpers/Discovery';
import * as UI from '../../constants/ui';
import {
    validatePath,
    getAccountLabel,
    getSerializedPath,
} from '../../utils/pathUtils';
import { create as createDeferred } from '../../utils/deferred';

import Account, { create as createAccount } from '../../account';
import BlockBook, { create as createBackend } from '../../backend';
import { getCoinInfoByCurrency, getAccountCoinInfo } from '../../data/CoinInfo';
import { UiMessage } from '../../message/builder';
import type { CoinInfo, UiPromiseResponse } from 'flowtype';
import type { AccountInfo, HDNodeResponse } from '../../types/trezor';
import type { Deferred, CoreMessage } from '../../types';

type Params = {
    path: ?Array<number>;
    xpub: ?string;
    coinInfo: CoinInfo;
}

type Response = AccountInfo | {
    error: string;
}

export default class GetAccountInfo extends AbstractMethod {

    params: Params;
    confirmed: boolean = false;
    backend: BlockBook;
    discovery: ?Discovery;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['read'];
        this.info = 'Export account info';

        const payload: Object = message.payload;

        let coinInfo: ?CoinInfo;
        if (payload.hasOwnProperty('coin')) {
            if (typeof payload.coin === 'string') {
                coinInfo = getCoinInfoByCurrency(payload.coin);
            } else {
                throw new Error('Parameter "coin" has invalid type. String expected.');
            }
        }

        if (!coinInfo) {
            throw new Error('Coin not found');
        } else {
            // check required firmware with coinInfo support
            this.requiredFirmware = [ coinInfo.support.trezor1, coinInfo.support.trezor2 ];
        }

        if (payload.hasOwnProperty('path')) {
            payload.path = validatePath(payload.path, true);
        } else if (payload.hasOwnProperty('xpub') && typeof payload.xpub !== 'string') {
            throw new Error('Parameter "xpub" has invalid type. String expected.');
        }

        // delete payload.path;
        // payload.xpub = 'ypub6XKbB5DSkq8Royg8isNtGktj6bmEfGJXDs83Ad5CZ5tpDV8QofwSWQFTWP2Pv24vNdrPhquehL7vRMvSTj2GpKv6UaTQCBKZALm6RJAmxG6'
        // payload.xpub = 'xpub6BiVtCpG9fQQNBuKZoKzhzmENDKdCeXQsNVPF2Ynt8rhyYznmPURQNDmnNnX9SYahZ1DVTaNtsh3pJ4b2jKvsZhpv2oVj76YETCGztKJ3LM'

        this.params = {
            path: payload.path,
            xpub: payload.xpub,
            coinInfo,
        }
    }

    async confirmation(): Promise<boolean> {
        if (this.confirmed) return true;
        // wait for popup window
        await this.getPopupPromise().promise;

        let label: string;
        if (this.params.path) {
            label = getAccountLabel(this.params.path, this.params.coinInfo);
        } else if (this.params.xpub) {
            label = `Export ${ this.params.coinInfo.label } account for public key <span>${ this.params.xpub }</span>`;
        } else {
            return true;
        }

        // request confirmation view
        this.postMessage(new UiMessage(UI.REQUEST_CONFIRMATION, {
            view: 'export-account-info',
            label,
        }));

        // wait for user action
        const uiResp: UiPromiseResponse = await this.createUiPromise(UI.RECEIVE_CONFIRMATION, this.device).promise;
        const resp: string = uiResp.payload;

        this.confirmed = (resp === 'true');
        return this.confirmed;
    }

    async run(): Promise<Response> {
        // initialize backend
        this.backend = await createBackend(this.params.coinInfo);

        if (this.params.path) {
            return await this._getAccountFromPath(this.params.path);
        } else if (this.params.xpub) {
            return await this._getAccountFromPublicKey();
        } else {
            return await this._getAccountFromDiscovery();
        }
    }

    async _getAccountFromPath(path: Array<number>): Promise<Response> {
        const coinInfo: CoinInfo = getAccountCoinInfo(this.params.coinInfo, path);
        const node: HDNodeResponse = await this.device.getCommands().getHDNode(path, coinInfo);
        const account = createAccount(path, node.xpub, coinInfo);

        const discovery: Discovery = this.discovery = new Discovery({
            getHDNode: this.device.getCommands().getHDNode.bind( this.device.getCommands() ),
            coinInfo: this.params.coinInfo,
            backend: this.backend,
            loadInfo: false,
        });

        await discovery.getAccountInfo(account);
        return this._response(account);
    }

    async _getAccountFromPublicKey(): Promise<Response> {

        const discovery: Discovery = this.discovery = new Discovery({
            getHDNode: this.device.getCommands().getHDNode.bind( this.device.getCommands() ),
            coinInfo: this.params.coinInfo,
            backend: this.backend,
            loadInfo: false,
        });

        const deferred: Deferred<Response> = createDeferred('account_discovery');
        discovery.on('update', async (accounts: Array<Account>) => {
            const account = accounts.find(a => a.xpub === this.params.xpub);
            if (account) {

                discovery.removeAllListeners();
                discovery.completed = true;

                await discovery.getAccountInfo(account);
                discovery.stop();
                deferred.resolve( this._response(account) );
            }
        });
        discovery.on('complete', () => {
            deferred.resolve( this._response(null) );
        });

        discovery.start();

        return await deferred.promise;
    }

    async _getAccountFromDiscovery(): Promise<Response> {

        const discovery: Discovery = this.discovery = new Discovery({
            getHDNode: this.device.getCommands().getHDNode.bind( this.device.getCommands() ),
            coinInfo: this.params.coinInfo,
            backend: this.backend,
        });

        discovery.on('update', (accounts: Array<Account>) => {
            this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
                coinInfo: this.params.coinInfo,
                accounts: accounts.map(a => a.toMessage()),
            }));
        });

        discovery.on('complete', (accounts: Array<Account>) => {
            this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
                coinInfo: this.params.coinInfo,
                accounts: accounts.map(a => a.toMessage()),
                complete: true
            }));
        });

        try {
            discovery.start();
        } catch(error) {
            return {
                error
            }
        }

        // set select account view
        // this view will be updated from discovery events
        this.postMessage(new UiMessage(UI.SELECT_ACCOUNT, {
            coinInfo: this.params.coinInfo,
            accounts: [],
            start: true
        }));

        // wait for user action
        const uiResp: UiPromiseResponse = await this.createUiPromise(UI.RECEIVE_ACCOUNT, this.device).promise;
        discovery.stop();

        const resp: number = parseInt(uiResp.payload);
        const account = discovery.accounts[resp];

        return this._response(account);
    }

    _response(account: ?Account): Response {

        if (!account) {
            return {
                error: "No account found"
            }
        }

        return {
            id: account.id,
            path: account.path,
            serializedPath: getSerializedPath(account.path),
            address: account.getNextAddress(),
            addressId: account.getNextAddressId(),
            addressPath: account.getAddressPath( account.getNextAddress() ),
            xpub: account.xpub,
            balance: account.getBalance(),
            confirmed: account.getConfirmedBalance(),
        }
    }

    dispose() {
        if (this.discovery) {
            const d = this.discovery;
            d.stop();
            d.removeAllListeners();
        }
    }
}
