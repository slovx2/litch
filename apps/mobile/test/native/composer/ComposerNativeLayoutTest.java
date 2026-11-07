package dev.litch.composer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import dev.litch.keyboard.HardwareKeyboardView;

// 使用真 Activity、Expo 容器和 RN 输入框，重放 Android 原生测量/布局遍历。
// 空、短、长、多行都必须保留 Yoga 给定的宽度，不能被 LinearLayout 按文字改写。
public class ComposerNativeLayoutTest extends InstrumentationTestCase {
  private Activity activity;

  private View find(View view, Class<?> type) {
    if (type.isInstance(view)) return view;
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) {
        View found = find(group.getChildAt(i), type);
        if (found != null) return found;
      }
    }
    return null;
  }

  private void link(String url) throws Exception {
    getInstrumentation().runOnMainSync(() -> {
      Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
      intent.setPackage("dev.litch.app");
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      activity.startActivity(intent);
    });
    Thread.sleep(1500);
    getInstrumentation().waitForIdleSync();
  }

  public void testNativeRelayoutKeepsComposerWidth() throws Exception {
    Intent launch = getInstrumentation().getTargetContext().getPackageManager()
      .getLaunchIntentForPackage("dev.litch.app");
    activity = getInstrumentation().startActivitySync(launch);
    link("litch://boot?mode=mock");
    for (String session : new String[] {"p2", "s2"}) {
      link("litch://open?session=" + session + "&device=local");
      final HardwareKeyboardView[] keyboard = new HardwareKeyboardView[1];
      final EditText[] field = new EditText[1];
      long deadline = System.currentTimeMillis() + 20000;
      while (keyboard[0] == null && System.currentTimeMillis() < deadline) {
        getInstrumentation().runOnMainSync(() -> {
          keyboard[0] = (HardwareKeyboardView) find(activity.getWindow().getDecorView(), HardwareKeyboardView.class);
          if (keyboard[0] != null) field[0] = (EditText) find(keyboard[0], EditText.class);
        });
        if (keyboard[0] == null) Thread.sleep(100);
      }
      assertNotNull("缺少原生键盘容器", keyboard[0]);
      assertNotNull("缺少原生输入框", field[0]);
      for (String text : new String[] {"", "ab", "a long line of text for native measurement", "ab\ncd"}) {
        getInstrumentation().runOnMainSync(() -> field[0].setText(text));
        Thread.sleep(300);
        getInstrumentation().waitForIdleSync();
        final int[] widths = new int[3];
        getInstrumentation().runOnMainSync(() -> {
          HardwareKeyboardView view = keyboard[0];
          int expected = view.getWidth();
          widths[0] = expected;
          widths[2] = field[0].getWidth();
          // 原生的 forceLayout/measure/layout 可发生在 IME 或窗口重新布局期间。
          view.forceLayout();
          view.measure(View.MeasureSpec.makeMeasureSpec(expected, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(view.getHeight(), View.MeasureSpec.EXACTLY));
          view.layout(view.getLeft(), view.getTop(), view.getRight(), view.getBottom());
          widths[1] = field[0].getWidth();
        });
        assertTrue("Yoga 未给出容器宽度", widths[0] > 100);
        // Yoga 分别按屏幕像素取整父子边界，边缘最多差 1px；重排前后必须完全一致。
        assertTrue("输入框未占满容器", Math.abs(widths[0] - widths[2]) <= 1);
        assertEquals("原生遍历改写了输入框宽度：" + session + " / " + text, widths[2], widths[1]);
      }
    }
  }
}
