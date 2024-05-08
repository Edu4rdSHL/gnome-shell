#include "config.h"

#include <clutter/clutter.h>

#include "shell-dnd-start-gesture.h"
#include "shell-global.h"

typedef struct _ShellDndStartGesture ShellDndStartGesture;
typedef struct _ShellDndStartGesturePrivate ShellDndStartGesturePrivate;

struct _ShellDndStartGesture
{
  ClutterGesture parent;

  ShellDndStartGesturePrivate *priv;
};

struct _ShellDndStartGesturePrivate
{
  gboolean drag_threshold_ignored;
  ClutterEvent *point_begin_event;
  ClutterEvent *drag_triggering_event;

  gboolean manual_mode;
  guint32 timeout_threshold_ms;
};

enum
{
  PROP_0,

  PROP_MANUAL_MODE,
  PROP_TIMEOUT_THRESHOLD,

  PROP_LAST
};

static GParamSpec *obj_props[PROP_LAST] = { NULL, };

G_DEFINE_TYPE_WITH_PRIVATE (ShellDndStartGesture, shell_dnd_start_gesture,
                            CLUTTER_TYPE_GESTURE);

static gboolean
should_handle_sequence (ClutterGesture     *gesture,
                        const ClutterEvent *sequence_begin_event)
{
  ClutterEventType event_type = clutter_event_type (sequence_begin_event);

  if (event_type == CLUTTER_BUTTON_PRESS ||
      event_type == CLUTTER_TOUCH_BEGIN)
    return TRUE;

  return FALSE;
}

static void
maybe_start_drag (ShellDndStartGesture *self,
                  unsigned int          point)
{
  ShellDndStartGesturePrivate *priv =
    shell_dnd_start_gesture_get_instance_private (self);
  const ClutterEvent *event;
  graphene_point_t begin_coords, coords;
  int drag_threshold;
  ClutterStage *stage;
  StThemeContext *theme_context;

  event = clutter_gesture_get_point_event (CLUTTER_GESTURE (self), point);

  clutter_gesture_get_point_begin_coords_abs (CLUTTER_GESTURE (self), point, &begin_coords);
  clutter_gesture_get_point_coords_abs (CLUTTER_GESTURE (self), point, &coords);

  if (priv->drag_threshold_ignored)
      return;

  g_object_get (G_OBJECT (st_settings_get ()),
                "drag-threshold", &drag_threshold,
                NULL);

  stage = shell_global_get_stage (shell_global_get ());
  theme_context = st_theme_context_get_for_stage (stage);
  drag_threshold *= st_theme_context_get_scale_factor (theme_context);

  if (ABS (coords.x - begin_coords.x) > drag_threshold ||
      ABS (coords.y - begin_coords.y) > drag_threshold)
    {
      ClutterInputDeviceType device_type;
      gboolean is_pointer_or_touchpad;
      guint32 ellapsed_time;

      device_type =
        clutter_input_device_get_device_type (clutter_event_get_source_device (event));
      is_pointer_or_touchpad =
        device_type == CLUTTER_POINTER_DEVICE ||
        device_type == CLUTTER_TOUCHPAD_DEVICE;
      ellapsed_time =
        clutter_event_get_time (event) - clutter_event_get_time (priv->point_begin_event);

      /* Pointer devices (e.g. mouse) start the drag immediately */
      if (is_pointer_or_touchpad || ellapsed_time > priv->timeout_threshold_ms)
        shell_dnd_start_gesture_start_drag (self, event);
      else
        priv->drag_threshold_ignored = true;
    }
}

static void
point_began (ClutterGesture *gesture,
             unsigned int    point)
{
  ShellDndStartGesture *self = SHELL_DND_START_GESTURE (gesture);
  ShellDndStartGesturePrivate *priv =
    shell_dnd_start_gesture_get_instance_private (self);
  const ClutterEvent *event;

  if (clutter_gesture_get_n_points (gesture) > 1)
    {
      clutter_gesture_set_state (gesture, CLUTTER_GESTURE_STATE_CANCELLED);
      return;
    }

  event = clutter_gesture_get_point_event (gesture, point);

  priv->point_begin_event = clutter_event_copy (event);
  priv->drag_threshold_ignored = FALSE;

  if (!priv->manual_mode &&
      clutter_gesture_get_state (gesture) == CLUTTER_GESTURE_STATE_POSSIBLE)
    maybe_start_drag (self, point);
}

static void
point_moved (ClutterGesture *gesture,
             unsigned int    point)
{
  ShellDndStartGesture *self = SHELL_DND_START_GESTURE (gesture);
  ShellDndStartGesturePrivate *priv =
    shell_dnd_start_gesture_get_instance_private (self);

  if (!priv->manual_mode &&
      clutter_gesture_get_state (gesture) == CLUTTER_GESTURE_STATE_POSSIBLE)
    maybe_start_drag (self, point);
}

static void
point_ended (ClutterGesture *gesture,
             unsigned int    point)
{
  if (clutter_gesture_get_state (gesture) == CLUTTER_GESTURE_STATE_POSSIBLE &&
      clutter_gesture_get_n_points (gesture) == 1)
    {
      /* All points were removed and we're still in POSSIBLE, this means
       * we're in manual mode and nobody told us to start the drag.
       */
      clutter_gesture_set_state (gesture, CLUTTER_GESTURE_STATE_CANCELLED);
    }
}

static void
state_changed (ClutterGesture      *gesture,
               ClutterGestureState  old_state,
               ClutterGestureState  new_state)
{
  ShellDndStartGesture *self = SHELL_DND_START_GESTURE (gesture);
  ShellDndStartGesturePrivate *priv =
    shell_dnd_start_gesture_get_instance_private (self);

  if (new_state == CLUTTER_GESTURE_STATE_CANCELLED ||
      new_state == CLUTTER_GESTURE_STATE_COMPLETED)
      {
        g_clear_pointer (&priv->drag_triggering_event, clutter_event_free);
        g_clear_pointer (&priv->point_begin_event, clutter_event_free);
      }
}

static void
shell_dnd_start_gesture_set_property (GObject      *gobject,
                                      unsigned int  prop_id,
                                      const GValue *value,
                                      GParamSpec   *pspec)
{
  ShellDndStartGesture *self = SHELL_DND_START_GESTURE (gobject);

  switch (prop_id)
    {
    case PROP_MANUAL_MODE:
      shell_dnd_start_gesture_set_manual_mode (self, g_value_get_boolean (value));
      break;

    case PROP_TIMEOUT_THRESHOLD:
      shell_dnd_start_gesture_set_timeout_threshold (self, g_value_get_uint (value));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
shell_dnd_start_gesture_get_property (GObject      *gobject,
                                      unsigned int  prop_id,
                                      GValue       *value,
                                      GParamSpec   *pspec)
{
  ShellDndStartGesture *self = SHELL_DND_START_GESTURE (gobject);

  switch (prop_id)
    {
    case PROP_MANUAL_MODE:
      g_value_set_boolean (value, shell_dnd_start_gesture_get_manual_mode (self));
      break;

    case PROP_TIMEOUT_THRESHOLD:
      g_value_set_uint (value, shell_dnd_start_gesture_get_timeout_threshold (self));
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (gobject, prop_id, pspec);
      break;
    }
}

static void
shell_dnd_start_gesture_init (ShellDndStartGesture *self)
{
}

static void
shell_dnd_start_gesture_class_init (ShellDndStartGestureClass *klass)
{
  ClutterGestureClass *gesture_class = CLUTTER_GESTURE_CLASS (klass);
  GObjectClass *gobject_class = G_OBJECT_CLASS (klass);

  gesture_class->should_handle_sequence = should_handle_sequence;
  gesture_class->point_began = point_began;
  gesture_class->point_moved = point_moved;
  gesture_class->point_ended = point_ended;
  gesture_class->state_changed = state_changed;

  gobject_class->set_property = shell_dnd_start_gesture_set_property;
  gobject_class->get_property = shell_dnd_start_gesture_get_property;

  obj_props[PROP_MANUAL_MODE] =
    g_param_spec_boolean ("manual-mode",
                          "manual-mode",
                          "manual-mode",
                          FALSE,
                          G_PARAM_READWRITE |
                          G_PARAM_STATIC_STRINGS |
                          G_PARAM_EXPLICIT_NOTIFY);

  obj_props[PROP_TIMEOUT_THRESHOLD] =
    g_param_spec_uint ("timeout-threshold",
                       "timeout-threshold",
                       "timeout-threshold",
                       0, G_MAXUINT, 0,
                       G_PARAM_READWRITE |
                       G_PARAM_STATIC_STRINGS |
                       G_PARAM_EXPLICIT_NOTIFY);

  g_object_class_install_properties (gobject_class, PROP_LAST, obj_props);
}

void
shell_dnd_start_gesture_start_drag (ShellDndStartGesture *self,
                                    const ClutterEvent   *start_event)
{
  ShellDndStartGesturePrivate *priv;

  g_return_if_fail (SHELL_IS_DND_START_GESTURE (self));

  priv = shell_dnd_start_gesture_get_instance_private (self);

  if (clutter_gesture_get_n_points (CLUTTER_GESTURE (self)) != 1)
    return;

  if (clutter_gesture_get_state (CLUTTER_GESTURE (self)) == CLUTTER_GESTURE_STATE_POSSIBLE)
    {
      if (start_event)
        priv->drag_triggering_event = clutter_event_copy (start_event);

      clutter_gesture_set_state (CLUTTER_GESTURE (self), CLUTTER_GESTURE_STATE_COMPLETED);
    }
}

const ClutterEvent *
shell_dnd_start_gesture_get_point_begin_event (ShellDndStartGesture *self)
{
  ShellDndStartGesturePrivate *priv;

  g_return_val_if_fail (SHELL_IS_DND_START_GESTURE (self), NULL);

  priv = shell_dnd_start_gesture_get_instance_private (self);

  return priv->point_begin_event;
}

const ClutterEvent *
shell_dnd_start_gesture_get_drag_triggering_event (ShellDndStartGesture *self)
{
  ShellDndStartGesturePrivate *priv;

  g_return_val_if_fail (SHELL_IS_DND_START_GESTURE (self), NULL);

  priv = shell_dnd_start_gesture_get_instance_private (self);

  return priv->drag_triggering_event;
}

gboolean
shell_dnd_start_gesture_get_manual_mode (ShellDndStartGesture *self)
{
  ShellDndStartGesturePrivate *priv;

  g_return_val_if_fail (SHELL_IS_DND_START_GESTURE (self), FALSE);

  priv = shell_dnd_start_gesture_get_instance_private (self);

  return priv->manual_mode;
}

void
shell_dnd_start_gesture_set_manual_mode (ShellDndStartGesture *self,
                                         gboolean              manual_mode)
{
  ShellDndStartGesturePrivate *priv;

  g_return_if_fail (SHELL_IS_DND_START_GESTURE (self));

  priv = shell_dnd_start_gesture_get_instance_private (self);

  if (priv->manual_mode == manual_mode)
    return;

  priv->manual_mode = manual_mode;

  g_object_notify_by_pspec (G_OBJECT (self), obj_props[PROP_MANUAL_MODE]);
}

guint32
shell_dnd_start_gesture_get_timeout_threshold (ShellDndStartGesture *self)
{
  ShellDndStartGesturePrivate *priv;

  g_return_val_if_fail (SHELL_IS_DND_START_GESTURE (self), 0);

  priv = shell_dnd_start_gesture_get_instance_private (self);

  return priv->timeout_threshold_ms;
}

void
shell_dnd_start_gesture_set_timeout_threshold (ShellDndStartGesture *self,
                                               guint32               timeout_threshold_ms)
{
  ShellDndStartGesturePrivate *priv;

  g_return_if_fail (SHELL_IS_DND_START_GESTURE (self));

  priv = shell_dnd_start_gesture_get_instance_private (self);

  if (priv->timeout_threshold_ms == timeout_threshold_ms)
    return;

  priv->timeout_threshold_ms = timeout_threshold_ms;

  g_object_notify_by_pspec (G_OBJECT (self), obj_props[PROP_TIMEOUT_THRESHOLD]);
}
