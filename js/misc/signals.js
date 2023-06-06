/* exported EventEmitter, DestroyableEventEmitter */

const Signals = imports.signals;
const SignalTracker = imports.misc.signalTracker;

var EventEmitter = class EventEmitter {
    connect_after(...args) {
        return this.connectAfter(...args);
    }

    connectObject(...args) {
        return SignalTracker.connectObject(this, ...args);
    }

    disconnectObject(...args) {
        return SignalTracker.disconnectObject(this, ...args);
    }

    connect_object(...args) {
        return this.connectObject(...args);
    }

    disconnect_object(...args) {
        return this.disconnectObject(...args);
    }
};

Signals.addSignalMethods(EventEmitter.prototype);

var DestroyableEventEmitter = class DestroyableEventEmitter extends EventEmitter {
    destroy() {
        this.emit('destroy');
    }
};
