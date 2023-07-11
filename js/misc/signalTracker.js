/* exported TransientSignalHolder, connectObject, disconnectObject */
const GObject = imports.gi.GObject;

const destroyableTypes = [];

// Add custom shell connection flags, ensuring we don't override standard ones
GObject.ConnectFlags.SHELL_ONCE = 1 << 25;

/**
 * @private
 * @param {Object} obj - an object
 * @returns {bool} - true if obj has a 'destroy' GObject signal
 */
function _hasDestroySignal(obj) {
    return destroyableTypes.some(type => obj instanceof type);
}

var TransientSignalHolder = GObject.registerClass(
class TransientSignalHolder extends GObject.Object {
    static [GObject.signals] = {
        'destroy': {},
    };

    constructor(owner) {
        super();

        if (_hasDestroySignal(owner)) {
            owner.connectObject('destroy', () => this.destroy(),
                GObject.ConnectFlags.AFTER, this);
        }
    }

    destroy() {
        this.emit('destroy');
    }
});
registerDestroyableType(TransientSignalHolder);

class SignalManager {
    /**
     * @returns {SignalManager} - the SignalManager singleton
     */
    static getDefault() {
        if (!this._singleton)
            this._singleton = new SignalManager();
        return this._singleton;
    }

    constructor() {
        this._signalTrackers = new Map();

        global.connect_after('shutdown', () => {
            [...this._signalTrackers.values()].forEach(
                tracker => tracker.destroy());
            this._signalTrackers.clear();
        });
    }

    /**
     * @param {Object} obj - object to get signal tracker for
     * @returns {SignalTracker} - the signal tracker for object
     */
    getSignalTracker(obj) {
        let signalTracker = this._signalTrackers.get(obj);
        if (signalTracker === undefined) {
            signalTracker = new SignalTracker(obj);
            this._signalTrackers.set(obj, signalTracker);
        }
        return signalTracker;
    }

    /**
     * @param {Object} obj - object to get signal tracker for
     * @returns {?SignalTracker} - the signal tracker for object if it exists
     */
    maybeGetSignalTracker(obj) {
        return this._signalTrackers.get(obj) ?? null;
    }

    /*
     * @param {Object} obj - object to remove signal tracker for
     * @returns {void}
     */
    removeSignalTracker(obj) {
        this._signalTrackers.delete(obj);
    }
}

class SignalTracker {
    /**
     * @param {Object=} owner - object that owns the tracker
     */
    constructor(owner) {
        this._owner = owner;
        this._map = new Map();

        if (_hasDestroySignal(owner))
            this._trackOwnerDestroy();
    }

    /**
     * @typedef SignalData
     * @property {number[]} ownerSignals - a list of handler IDs
     * @property {number} destroyId - destroy handler ID of tracked object
     */

    /**
     * @private
     * @param {Object} obj - a tracked object
     * @returns {SignalData} - signal data for object
     */
    _getSignalData(obj) {
        let data = this._map.get(obj);
        if (data === undefined) {
            data = { ownerSignals: [], destroyId: 0 };
            this._map.set(obj, data);
        }
        return data;
    }

    /**
     * Reconnects to owner 'destroy' if any
     */
    updateOwnerDestroyTracker() {
        if (!this._ownerDestroyId)
            return;

        this._disconnectSignal(this._owner, this._ownerDestroyId);
        this._trackOwnerDestroy();
    }

    /**
     * @private
     */
    _trackOwnerDestroy() {
        this._ownerDestroyId = this._owner.connect_after('destroy',
            () => this.clear());
    }

    /**
     * @private
     * @param {GObject.Object} obj - tracked widget
     * @param {object} signalData - object signal data, got via _getSignalData()
     */
    _trackDestroy(obj, signalData) {
        if (signalData.destroyId)
            throw new Error('Destroy already tracked');
        if (obj === this._owner)
            return;
        signalData.destroyId = obj.connect_after('destroy', () => this.untrack(obj));
    }

    _disconnectSignalForProto(proto, obj, id) {
        proto['disconnect'].call(obj, id);
    }

    _getObjectProto(obj) {
        return obj instanceof GObject.Object
            ? GObject.Object.prototype
            : Object.getPrototypeOf(obj);
    }

    _disconnectSignal(obj, id) {
        this._disconnectSignalForProto(this._getObjectProto(obj), obj, id);
    }

    _removeTracker() {
        if (this._ownerDestroyId)
            this._disconnectSignal(this._owner, this._ownerDestroyId);

        SignalManager.getDefault().removeSignalTracker(this._owner);

        delete this._ownerDestroyId;
        delete this._owner;
    }

    /**
     * @param {Object} obj - tracked object
     * @param {...number} handlerIds - tracked handler IDs
     * @returns {void}
     */
    track(obj, ...handlerIds) {
        const signalData = this._getSignalData(obj);

        if (!signalData.destroyId && _hasDestroySignal(obj))
            this._trackDestroy(obj, signalData);

        signalData.ownerSignals.push(...handlerIds);
    }

    /**
     * @param {Object} obj - tracked object instance
     * @returns {void}
     */
    untrack(obj) {
        const { ownerSignals, destroyId } = this._getSignalData(obj);
        this._map.delete(obj);

        const ownerProto = this._getObjectProto(this._owner);
        ownerSignals.forEach(id =>
            this._disconnectSignalForProto(ownerProto, this._owner, id));
        if (destroyId)
            this._disconnectSignal(obj, destroyId);

        if (this._map.size === 0)
            this._removeTracker();
    }

    /**
     * @param {object} obj - tracked object instance
     * @param {...number} handlerIds - tracked handler IDs to untrack
     * @returns {void}
     */
    untrackIds(obj, ...handlerIds) {
        const {ownerSignals} = this._getSignalData(obj);
        const ownerProto = this._getObjectProto(this._owner);

        handlerIds.forEach(id => {
            this._disconnectSignalForProto(ownerProto, this._owner, id);
            ownerSignals.splice(ownerSignals.indexOf(id), 1);
        });

        if (!ownerSignals.length)
            this.untrack(obj);
    }

    /**
     * @returns {void}
     */
    clear() {
        this._map.forEach((_, obj) => this.untrack(obj));
    }

    /**
     * @returns {void}
     */
    destroy() {
        this.clear();
        this._removeTracker();
    }
}

/**
 * Connect one or more signals, and associate the handlers
 * with a tracked object.
 *
 * All handlers for a particular object can be disconnected
 * by calling disconnectObject(). If object is a {Clutter.widget},
 * this is done automatically when the widget is destroyed.
 *
 * @param {object} thisObj - the emitter object
 * @param {...any} args - a sequence of signal-name/handler pairs
 * with an optional flags value, followed by an object to track
 * @returns {void}
 */
function connectObject(thisObj, ...args) {
    let flagsMask = 0;
    Object.values(GObject.ConnectFlags).forEach(v => (flagsMask |= v));

    const getParams = argArray => {
        const [signalName, handler, arg, ...rest] = argArray;
        if (typeof arg !== 'number')
            return [signalName, handler, 0, arg, ...rest];

        const flags = arg;
        if (flags && (flags & flagsMask) !== flags)
            throw new Error(`Invalid flag value ${flags}`);
        return [signalName, handler, flags, ...rest];
    };

    const signalManager = SignalManager.getDefault();
    let obj;

    const connectSignal = (emitter, signalName, handler, flags) => {
        let connectionId;
        const isGObject = emitter instanceof GObject.Object;
        const func = (flags & GObject.ConnectFlags.AFTER) && isGObject
            ? 'connect_after'
            : 'connect';
        const orderedHandler = flags & GObject.ConnectFlags.SWAPPED
            ? (instance, ...handlerArgs) => handler(...handlerArgs, instance)
            : handler;
        const realHandler = flags & GObject.ConnectFlags.SHELL_ONCE
            ? (...handlerArgs) => {
                const tracker = signalManager.getSignalTracker(emitter);
                tracker.untrackIds(obj, connectionId);
                return orderedHandler(...handlerArgs);
            }
            : orderedHandler;

        const emitterProto = isGObject
            ? GObject.Object.prototype
            : Object.getPrototypeOf(emitter);
        connectionId = emitterProto[func].call(emitter, signalName, realHandler);
        return connectionId;
    };

    let trackingAfterDestroy = false;
    const signalIds = [];
    while (args.length > 1) {
        const [signalName, handler, flags, ...rest] = getParams(args);
        signalIds.push(connectSignal(thisObj, signalName, handler, flags));
        if (signalName === 'destroy' && flags & GObject.ConnectFlags.AFTER)
            trackingAfterDestroy = true;
        args = rest;
    }

    obj = args.at(0) ?? globalThis;
    const tracker = signalManager.getSignalTracker(thisObj);

    if (trackingAfterDestroy)
        tracker.updateOwnerDestroyTracker();

    tracker.track(obj, ...signalIds);
}

/**
 * Disconnect all signals that were connected for
 * the specified tracked object
 *
 * @param {Object} thisObj - the emitter object
 * @param {Object} obj - the tracked object
 * @returns {void}
 */
function disconnectObject(thisObj, obj) {
    SignalManager.getDefault().maybeGetSignalTracker(thisObj)?.untrack(
        obj ?? globalThis);
}

/**
 * Register a GObject type as having a 'destroy' signal
 * that should disconnect all handlers
 *
 * @param {GObject.Type} gtype - a GObject type
 */
function registerDestroyableType(gtype) {
    if (!GObject.type_is_a(gtype, GObject.Object))
        throw new Error(`${gtype} is not a GObject subclass`);

    if (!GObject.signal_lookup('destroy', gtype))
        throw new Error(`${gtype} does not have a destroy signal`);

    destroyableTypes.push(gtype);
}
