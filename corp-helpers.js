import { log } from "./helpers";

/**
 * @typedef {Object} CorpConstants
 * @property {Number} kCorpBribePort Port for requesting bribes.
 */
export const CORP_CONSTANTS = {
    kCorpBribePort: 17,
    // One billion per rep for bribes.
    kBribeDivisor: 1e9,
};

export const kEmptyPortString = `NULL PORT DATA`;

/**
 * Encodes a given `faction` and `reputation` to write to a port.
 * @param {String} faction name of faction
 * @param {Number} targetReputation amount of reputation
 * @returns {String} json-encoded string to write to port
 */
export function encodeBribe(faction, targetReputation) {
    const bribe = { faction: faction, targetReputation: targetReputation };
    return JSON.stringify(bribe);
}

/**
 * @typedef {Object} Bribe
 * @property {String} faction name of the faction to bribe
 * @property {Number} targetReputation target reputation to achieve
 */

/**
 * Returns the cost of bribing a faction.
 * @param {Number} currentRep current reputation
 * @param {Number} desiredRep desired reputation
 * @returns {Number} cost of increasing `currentRep` to `desiredRep` via corp bribe
 */
export function getBribeCost(currentRep, desiredRep) {
    const reqRep = Math.max(Math.ceil(desiredRep - currentRep), 0);
    return reqRep * CORP_CONSTANTS.kBribeDivisor;
}

/**
 * Requests that we bribe a given `faction` to increase our rep by `reputation`.
 * @param {NS} ns ya boy
 * @param {String} faction name of faction
 * @param {Number} targetReputation requested target for the reputation
 */
export async function requestBribe(ns, faction, targetReputation) {
    await ns.tryWritePort(CORP_CONSTANTS.kCorpBribePort, encodeBribe(faction, targetReputation));
}

/**
 * Wrapper for the corp bribe port for easy reading of bribes.
 * @member {NetscriptPort} netPort
 */
export class CorpBribePort {
    /**
     * @param {NS} ns 
     */
    constructor(ns) {
        this.netPort = ns.getPortHandle(CORP_CONSTANTS.kCorpBribePort);
        // Empty the port on startup.
        this.clear();
        // Utility reference. Need to be careful with this.
        this.ns = ns;
    }

    /**
     * @returns true if the underlying port is empty, false otherwise.
     */
    isEmpty() {
        return this.netPort.empty();
    }
    /**
     * Empties the port of all messages.
     */
    clear() {
        this.netPort.clear();
    }
    /**
     * Attempt to read a bribe from the port.
     * @returns {Bribe} bribe if one is in the port, undefined otherwise
     */
    readBribe() {
        const data = String(this.netPort.read());
        // log(this.ns, `Read Bribe: ${data}`);
        if (data === kEmptyPortString)
            return undefined;
        return this.decodeBribe(data);
    }
    /**
     * Decode a bribe from the port, or `undefined` if unable to decode.
     * @param {String} encoded_bribe 
     * @returns {Bribe} decoded bribe or `undefined` if it could not be decoded.
     */
    decodeBribe(encoded_bribe) {
        try {
            return JSON.parse(encoded_bribe);
        } catch (error) {
            this.ns.print(`ERROR: Could not decode bribe ${encoded_bribe} because: ${error}`);
            return undefined;
        }
    }
}