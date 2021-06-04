testconf = configuration_data()
testconf.set('MUTTER_TYPELIB_DIR', mutter_typelibdir)
testconf.set('srcdir', meson.current_source_dir())
run_test = configure_file(
  input: 'run-test.sh.in',
  output: 'run-test.sh',
  configuration: testconf
)

testenv = environment()
testenv.set('GSETTINGS_SCHEMA_DIR', join_paths(meson.build_root(), 'data'))

unit_tests = [
  'insertSorted',
  'jsParse',
  'markup',
  'params',
  'url',
  'versionCompare',
]

foreach test : unit_tests
  test(test, run_test,
    args: 'unit/@0@.js'.format(test),
    env: testenv,
    suite: ['unit'],
    workdir: meson.current_source_dir())
endforeach
