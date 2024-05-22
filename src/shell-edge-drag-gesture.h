#ifndef __SHELL_EDGE_DRAG_GESTURE_H__
#define __SHELL_EDGE_DRAG_GESTURE_H__

G_BEGIN_DECLS

#include <clutter/clutter.h>
#include <st/st.h>

#define SHELL_TYPE_EDGE_DRAG_GESTURE (shell_edge_drag_gesture_get_type ())
G_DECLARE_FINAL_TYPE (ShellEdgeDragGesture, shell_edge_drag_gesture,
                      SHELL, EDGE_DRAG_GESTURE, ClutterGesture)

void shell_edge_drag_gesture_set_side (ShellEdgeDragGesture *self,
                                       StSide                side);

StSide shell_edge_drag_gesture_get_side (ShellEdgeDragGesture *self);

G_END_DECLS

#endif /* __SHELL_EDGE_DRAG_GESTURE_H__ */
