package com.swmansion.enriched.markdown.utils.text.view

import android.app.Activity
import android.graphics.Matrix
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.text.Selection
import android.text.Spannable
import android.view.View
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [35])
class SelectionScrollTest {
  private val viewport = RectF(0f, 246f, 1080f, 1380f)

  @Test fun visibleSelectionDoesNotMoveTheList() {
    assertEquals(0, selectionScrollDelta(RectF(42f, 500f, 1038f, 620f), viewport, Matrix()))
  }

  @Test fun invertedListScrollsInTheOppositeDirection() {
    val inverted = Matrix().apply { setRotate(180f, 540f, 567f) }
    assertEquals(-120, selectionScrollDelta(RectF(42f, 1300f, 1038f, 1500f), viewport, inverted))
    assertEquals(46, selectionScrollDelta(RectF(42f, 200f, 1038f, 300f), viewport, inverted))
  }

  @Test fun bottomBarsChangeTheViewportNotTheFingerOrigin() {
    val target = RectF(42f, 1200f, 1038f, 1360f)
    val inverted = Matrix().apply { setRotate(180f) }
    assertEquals(0, selectionScrollDelta(target, viewport, inverted))
    val withBackgroundBar = RectF(viewport).apply { bottom -= 100f }
    assertEquals(-80, selectionScrollDelta(target, withBackgroundBar, inverted))
  }

  @Test fun scaleIsAppliedToTheScrollVectorWithoutItsTranslation() {
    val scaled = Matrix().apply {
      setScale(2f, -2f)
      postTranslate(123f, 456f)
    }
    assertEquals(-60, selectionScrollDelta(RectF(42f, 1300f, 1038f, 1500f), viewport, scaled))
  }

  @Test fun nestedInversionsIncludeScrollAndWindowOffsets() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val root = FrameLayout(activity)
    activity.setContentView(root)
    val list = FrameLayout(activity)
    val cell = FrameLayout(activity)
    val text = View(activity)
    root.addView(list)
    list.addView(cell)
    cell.addView(text)
    root.layout(0, 0, 1080, 1920)
    list.layout(0, 246, 1080, 1380)
    list.rotation = 180f
    cell.layout(0, 2000, 1080, 2944)
    cell.rotation = 180f
    text.layout(42, 30, 1038, 800)
    list.scrollTo(0, 1500)
    val point = floatArrayOf(0f, 0f, 0f, 100f)
    localToScreen(text).mapPoints(point)
    val nativeOrigin = IntArray(2)
    text.getLocationOnScreen(nativeOrigin)
    assertEquals(nativeOrigin[0].toFloat(), point[0], 0.01f)
    assertEquals(nativeOrigin[1].toFloat(), point[1], 0.01f)
    assertEquals(100f, point[3] - point[1], 0.01f)
    list.scrollBy(0, 300)
    val moved = floatArrayOf(0f, 0f)
    localToScreen(text).mapPoints(moved)
    assertEquals(300f, moved[1] - point[1], 0.01f)
    activity.finish()
  }

  @Test fun movingStartDoesNotPullTheOffscreenEndBack() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    activity.setTheme(androidx.appcompat.R.style.Theme_AppCompat)
    val root = FrameLayout(activity)
    val scroll = ScrollView(activity)
    val text = object : AccessibleMarkdownTextView(activity) {}
    text.textSize = 20f
    text.setTextIsSelectable(true)
    text.setText((1..80).joinToString("\n") { "第 $it 行的选字测试" }, TextView.BufferType.SPANNABLE)
    scroll.addView(text)
    root.addView(scroll, FrameLayout.LayoutParams(1080, 1134).apply { topMargin = 246 })
    activity.setContentView(root)
    root.measure(
      View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
    )
    root.layout(0, 0, 1080, 1920)
    val lines = text.layout
    val content = text.text as Spannable
    Selection.setSelection(content, lines.getLineStart(3), lines.getLineStart(50))
    Selection.setSelection(content, lines.getLineStart(4), lines.getLineStart(50))
    text.requestRectangleOnScreen(Rect(0, 0, 10, 10), true)
    assertEquals("拖起点时不追屏幕外的终点", 0, scroll.scrollY)
    Selection.setSelection(content, lines.getLineStart(4), lines.getLineStart(51))
    text.requestRectangleOnScreen(Rect(0, 0, 10, 10), true)
    val end = floatArrayOf(0f, (lines.getLineBottom(51) + text.totalPaddingTop).toFloat())
    localToScreen(text).mapPoints(end)
    assertTrue("拖终点时让终点露出", end[1] < 1380f)
    assertTrue("只滚所需距离", end[1] > 1200f)
    activity.finish()
  }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun handleGraphicIsClippedAfterManualScroll() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val root = FrameLayout(activity)
    val scroll = ScrollView(activity)
    val text = TextView(activity)
    text.textSize = 20f
    text.setText((1..80).joinToString("\n") { "selection $it" }, TextView.BufferType.SPANNABLE)
    scroll.addView(text)
    root.addView(scroll, FrameLayout.LayoutParams(1080, 1134).apply { topMargin = 246 })
    activity.setContentView(root)
    root.measure(
      View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
    )
    root.layout(0, 0, 1080, 1920)
    val lines = text.layout
    val offset = lines.getLineStart(50)
    Selection.setSelection(text.text as Spannable, offset, offset + 3)
    scroll.scrollTo(0, lines.getLineBottom(50) + text.totalPaddingTop - 1114)
    var handle = ClippedSelectionHandle(text, ColorDrawable(Color.RED), false)
    handle.setBounds(0, 0, 60, 60)
    fun render(): Bitmap {
      val bitmap = Bitmap.createBitmap(60, 60, Bitmap.Config.ARGB_8888)
      handle.draw(Canvas(bitmap))
      return bitmap
    }
    val clipped = render()
    assertEquals("列表内仍画系统把手", Color.RED, clipped.getPixel(30, 10))
    assertEquals("下半部不能伸进输入区", Color.TRANSPARENT, clipped.getPixel(30, 30))
    scroll.scrollBy(0, 100)
    val refreshed = handle.refreshed()
    assertTrue("弹窗位置变了时必须刷新缓存图形", refreshed != null)
    // 与系统 HandleView 一样，换图形后每次绘制前设置尺寸。
    handle = refreshed!!
    handle.setBounds(0, 0, 60, 60)
    assertEquals("滚回列表内恢复完整把手", Color.RED, render().getPixel(30, 50))
    assertEquals("位置没变不重复刷新", null, handle.refreshed())
    activity.finish()
  }
}
