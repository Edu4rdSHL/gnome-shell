// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// Test cases for version comparison

const { GObject } = imports.gi;

const {testUtils: TestUtils} = imports.unit;
const {testCase} = TestUtils;

const JsUnit = imports.jsUnit;
const Signals = imports.misc.signals;

const Environment = imports.ui.environment;
const { TransientSignalHolder, registerDestroyableType } = imports.misc.signalTracker;

Environment.init();

const Destroyable = GObject.registerClass({
    Signals: { 'destroy': {} },
}, class Destroyable extends GObject.Object {});
registerDestroyableType(Destroyable);

const GObjectEmitter = GObject.registerClass({
    Signals: { 'signal': {} },
}, class GObjectEmitter extends Destroyable {});

testCase('Signals.DestroyableEventEmitter can be registered as Destroyable types', () => {
    class JSDestroyable extends Signals.DestroyableEventEmitter {}
    registerDestroyableType(JSDestroyable);
    registerDestroyableType(class OtherDestroyable extends JSDestroyable {});
});

class JSDestroyable extends Signals.DestroyableEventEmitter {}
registerDestroyableType(JSDestroyable);

testCase('Signal emissions can be tracked', () => {
    const emitter1 = new Signals.EventEmitter();
    const emitter2 = new GObjectEmitter();
    const emitter3 = new Signals.DestroyableEventEmitter();

    const tracked1 = new Destroyable();
    const tracked2 = {};
    const tracked3 = new JSDestroyable();

    let count = 0;
    const handler = () => count++;
    const handlerPreChecked = expected => {
        JsUnit.assertEquals(expected, count);
        handler();
    };

    emitter1.connectObject('signal', handler, tracked1);
    emitter2.connectObject('signal', handler, tracked1);
    emitter3.connectObject('signal', handler, tracked1);

    emitter1.connectObject('signal', handler, tracked2);
    emitter2.connectObject('signal', handler, tracked2);
    emitter3.connectObject('signal', handler, tracked2);

    emitter1.connectObject('signal', handler, tracked3);
    emitter2.connectObject('signal', handler, tracked3);
    emitter3.connectObject('signal', handler, tracked3);

    JsUnit.assertEquals(count, 0);

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 9);

    tracked1.emit('destroy');

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 15);

    emitter1.disconnectObject(tracked2);
    emitter1.disconnectObject(tracked3);
    emitter2.emit('destroy');
    emitter3.emit('destroy');

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 15);

    emitter1.connectObject(
        'signal', () => handlerPreChecked(16), GObject.ConnectFlags.AFTER,
        'signal', () => handlerPreChecked(15),
        tracked1);
    emitter2.connectObject(
        'signal', () => handlerPreChecked(18), GObject.ConnectFlags.AFTER,
        'signal', () => handlerPreChecked(17),
        tracked1);
    emitter3.connectObject(
        'signal', () => handlerPreChecked(20), GObject.ConnectFlags.AFTER,
        'signal', () => handlerPreChecked(19),
        tracked1);

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 21);

    tracked1.emit('destroy');
    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 21);

    emitter1.connectObject('signal', handler, tracked1);
    emitter2.connectObject('signal', handler, tracked1);
    emitter3.connectObject('signal', handler, tracked1);

    let transientHolder = new TransientSignalHolder(tracked1);

    emitter1.connectObject('signal', handler, transientHolder);
    emitter2.connectObject('signal', handler, transientHolder);
    emitter3.connectObject('signal', handler, transientHolder);

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 27);

    transientHolder.destroy();

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 30);

    transientHolder = new TransientSignalHolder(tracked1);

    emitter1.connectObject('signal', handler, transientHolder);
    emitter2.connectObject('signal', handler, transientHolder);
    emitter3.connectObject('signal', handler, transientHolder);

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 36);

    tracked1.emit('destroy');
    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 36);

    emitter1.connectObject('signal', handler, tracked3);
    emitter2.connectObject('signal', handler, tracked3);
    emitter3.connectObject('signal', handler,
        'signal', handler, GObject.ConnectFlags.AFTER,
        tracked3);

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 40);

    tracked3.destroy();

    emitter1.emit('signal');
    emitter2.emit('signal');
    emitter3.emit('signal');

    JsUnit.assertEquals(count, 40);
});

testCase('JS Emitter is same of tracker', () => {
    const obj = new JSDestroyable();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true), obj);

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.emit('destroy');

    callbackCalled = false;
    obj.emit('signal');
    JsUnit.assertFalse(callbackCalled);
});

testCase('JS Emitter is same of tracker after', () => {
    const obj = new JSDestroyable();
    let destroyCalled = false;

    obj.connectObject('destroy', () => (destroyCalled = true),
        GObject.ConnectFlags.AFTER, obj);

    obj.emit('destroy');
    JsUnit.assertTrue(destroyCalled);

    destroyCalled = false;
    JsUnit.assertFalse(destroyCalled);
    obj.emit('destroy');
});

testCase('Emitter is same of tracker does not block after-destroy signals', () => {
    let destroyCalled = false;
    const obj = new JSDestroyable();

    obj.connectObject('destroy', () => (destroyCalled = true),
        GObject.ConnectFlags.AFTER, obj);

    obj.emit('destroy');
    JsUnit.assertTrue(destroyCalled);

    destroyCalled = false;
    JsUnit.assertFalse(destroyCalled);
    obj.emit('destroy');
});

testCase('JS Emitter is disconnected on tracker destruction', () => {
    const obj = new JSDestroyable();
    const tracker = new JSDestroyable();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true), tracker);

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    tracker.emit('destroy');

    callbackCalled = false;
    obj.emit('signal');
    JsUnit.assertFalse(callbackCalled);
});

testCase('Emitter with no tracker, disconnects on destruction', () => {
    const obj = new JSDestroyable();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.emit('destroy');

    callbackCalled = false;
    obj.emit('signal');
    JsUnit.assertFalse(callbackCalled);
});

testCase('Emitter with empty tracker, disconnects on disconnectObject', () => {
    const obj = new JSDestroyable();
    const tracker = {};

    let callbackCalled = false;
    obj.connectObject('signal', () => (callbackCalled = true), tracker);

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.disconnectObject(tracker);

    callbackCalled = false;
    obj.emit('signal');
    JsUnit.assertFalse(callbackCalled);
});

testCase('Emitter with no tracker, disconnects on disconnectObject', () => {
    const obj = new JSDestroyable();
    let callbackCalled = false;
    obj.connectObject('signal', () => (callbackCalled = true));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.disconnectObject();

    callbackCalled = false;
    obj.emit('signal');
    JsUnit.assertFalse(callbackCalled);
});
