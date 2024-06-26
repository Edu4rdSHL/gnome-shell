use strict;
use warnings;
use testapi;
use autotest;
use needle;
use File::Basename;

my $distri = testapi::get_required_var('CASEDIR') . '/lib/gnomeosdistribution.pm';
require $distri;
testapi::set_distribution(gnomeosdistribution->new);

$testapi::username = 'testuser';
$testapi::password = 'testingtesting123';

my $testsuite = testapi::get_required_var('TEST');

if ($testsuite eq "gnome_apps") {
    $testapi::form_factor_postfix = '';
    autotest::loadtest("tests/gnome_welcome.pm");
    autotest::loadtest("tests/gnome_disable_update_notification.pm");
    autotest::loadtest("tests/gnome_desktop.pm");

} else {
    die("Invalid testsuite: '$testsuite'");
}

1;
