use base 'basetest';
use strict;
use testapi;

sub run {
    my $self = shift;

    # App tests fail if the "Software Updates Ready to Install" notification
    # appears over the top.
    select_console('user-virtio-terminal');
    assert_script_run('gsettings set org.gnome.desktop.notifications.application:/org/gnome/desktop/notifications/application/org-gnome-software/ enable false');
    assert_script_run('cat /proc/cmdline');
    assert_script_run('ls -la /dev/');
    assert_script_run('ls -la /var/lib/extensions/extension/usr/bin/');
    assert_script_run('ls -la /usr/lib/x86_64-linux-gnu/libwayland-egl.so.1.23.0');
    assert_script_run('ls -la /usr/bin/mutter');
    assert_script_run('ls -la /usr/bin/gnome-shell');
    assert_script_run('ls -la /usr/lib/extension-release.d/');

    select_console('x11');
}

1;
