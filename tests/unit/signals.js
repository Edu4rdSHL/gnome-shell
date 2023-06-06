// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const {jsUnit: JsUnit} = imports;
const {testUtils: TestUtils} = imports.unit;
const {testCase} = TestUtils;
const {signals: Signals} = imports.misc;

const Environment = imports.ui.environment;

Environment.init();

testCase('EventEmitter simple connections', () => {
    let fooCalled = 0, barCalled = 0;
    const emitter = new Signals.EventEmitter();
    const idFoo = emitter.connect('foo', () => ++fooCalled);
    const idBar = emitter.connect('bar', () => ++barCalled);

    emitter.emit('foo');
    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idBar);
    emitter.emit('bar');
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idFoo);
});

testCase('EventEmitter callbacks blocked', () => {
    let fooCalled = false, foo2Called = false;
    const emitter = new Signals.EventEmitter();

    emitter.connect('foo', () => {
        fooCalled = true;
        return true;
    });
    emitter.connect('foo', () => (foo2Called = true));

    emitter.emit('foo');

    JsUnit.assertTrue(fooCalled);
    JsUnit.assertFalse(foo2Called);
});

testCase('EventEmitter connections', () => {
    let fooCalled = 0, barCalled = 0;
    const emitter = new Signals.EventEmitter();
    emitter.disconnect(emitter.connect('foo', () => TestUtils.assertNotReached()));
    const idFoo = emitter.connect('foo', (self, ...args) => {
        JsUnit.assertEquals(self, emitter);
        TestUtils.assertArrayEquals(args, ['args', 5, null, emitter]);
        fooCalled++;
    });
    const idBar = emitter.connect('bar', () => ++barCalled);

    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('foo', 'args', 5, null, emitter);
    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idBar);
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('bar');
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idFoo);
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));
});

testCase('DestroyableEventEmitter connections', () => {
    let fooCalled = 0, barCalled = 0;
    const emitter = new Signals.DestroyableEventEmitter();
    emitter.disconnect(emitter.connect('foo', () => TestUtils.assertNotReached()));
    const idFoo = emitter.connect('foo', (self, ...args) => {
        JsUnit.assertEquals(self, emitter);
        TestUtils.assertArrayEquals(args, ['args', 5, null, emitter]);
        fooCalled++;
    });
    const idBar = emitter.connect('bar', () => ++barCalled);

    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('foo', 'args', 5, null, emitter);
    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idBar);
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('bar');
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idFoo);
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));
});

testCase('DestroyableEventEmitter destroy', () => {
    let destroyCalled = 0;

    const emitter = new Signals.DestroyableEventEmitter();
    const id = emitter.connect('destroy', () => destroyCalled++);

    emitter.destroy();
    JsUnit.assertEquals(1, destroyCalled);

    emitter.destroy();
    JsUnit.assertEquals(2, destroyCalled);

    emitter.disconnect(id);
    emitter.destroy();
    JsUnit.assertEquals(2, destroyCalled);
});

testCase('EventEmitter connectAfter', () => {
    let fooCalled = 0, fooAfterCalled = 0;
    const emitter = new Signals.EventEmitter();

    emitter.disconnect(emitter.connect_after('foo', () => TestUtils.assertNotReached()));
    const idAfter = emitter.connect_after('foo', (self, ...args) => {
        JsUnit.assertEquals(emitter, self);
        TestUtils.assertArrayEquals(args, ['args', 5, null, emitter]);
        JsUnit.assertEquals(2, fooCalled);
        JsUnit.assertEquals(0, fooAfterCalled);
        fooAfterCalled++;
    });
    const id = emitter.connect('foo', (self, ...args) => {
        JsUnit.assertEquals(emitter, self);
        TestUtils.assertArrayEquals(args, ['args', 5, null, emitter]);
        JsUnit.assertEquals(0, fooCalled);
        JsUnit.assertEquals(0, fooAfterCalled);
        fooCalled++;
    });
    emitter.connect('foo', () => fooCalled++);
    emitter.connect_after('foo', () => fooAfterCalled++);
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idAfter));
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(id));

    JsUnit.assertEquals(0, fooCalled);
    JsUnit.assertEquals(0, fooAfterCalled);

    emitter.emit('foo', 'args', 5, null, emitter);
    JsUnit.assertEquals(2, fooCalled);
    JsUnit.assertEquals(2, fooAfterCalled);

    emitter.disconnect(id);
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(id));
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idAfter));

    emitter.disconnect(idAfter);
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idAfter));

    emitter.emit('foo');
    JsUnit.assertEquals(3, fooCalled);
    JsUnit.assertEquals(3, fooAfterCalled);

    emitter.disconnectAll();

    emitter.emit('foo');
    JsUnit.assertEquals(3, fooCalled);
    JsUnit.assertEquals(3, fooAfterCalled);
});

testCase('EventEmitter connectAfter blocked', () => {
    let fooCalled = false, fooAfterCalled = false;
    const emitter = new Signals.EventEmitter();

    emitter.connect('foo', () => {
        fooCalled = true;
        return true;
    });
    emitter.connect_after('foo', () => (fooAfterCalled = true));

    emitter.emit('foo');

    JsUnit.assertTrue(fooCalled);
    JsUnit.assertFalse(fooAfterCalled);
});

testCase('EventEmitter connectAfter connected before not blocked', () => {
    let fooCalled = 0, fooAfterCalled = 0;
    const emitter = new Signals.EventEmitter();

    emitter.connect_after('foo', () => fooAfterCalled++);
    emitter.connect('foo', () => fooCalled++);

    emitter.emit('foo');

    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(1, fooAfterCalled);
});

testCase('EventEmitter connectAfter connected before blocked', () => {
    let fooCalled = false, fooAfterCalled = false;
    const emitter = new Signals.EventEmitter();

    emitter.connect_after('foo', () => (fooAfterCalled = true));
    emitter.connect('foo', () => (fooCalled = true));

    emitter.emit('foo');

    JsUnit.assertTrue(fooCalled);
    JsUnit.assertFalse(fooAfterCalled);
});

testCase('EventEmitter connect after by name fails', () => {
    const emitter = new Signals.EventEmitter();
    TestUtils.assertRaisesError(() => emitter.connect('after::foo', () => {}),
        'Signal name not allowed: after::foo');
});
