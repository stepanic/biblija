package hr.stepanic.biblija.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import hr.stepanic.biblija.R
import hr.stepanic.biblija.ReaderTheme
import hr.stepanic.biblija.core.BookmarkColor

/** Boje iz styles.css (:root, [data-theme="sepia"], [data-theme="dark"]). */
data class Palette(
    val background: Color,
    val surface: Color,
    val text: Color,
    val muted: Color,
    val accent: Color,
    val isDark: Boolean,
) {
    fun highlight(color: BookmarkColor): Color {
        val alpha = if (isDark) 0.25f else 0.32f
        return when (color) {
            BookmarkColor.GOLD -> Color(245, 194, 66)
            BookmarkColor.GREEN -> Color(102, 187, 106)
            BookmarkColor.BLUE -> Color(66, 165, 245)
            BookmarkColor.PINK -> Color(236, 64, 122)
        }.copy(alpha = alpha)
    }

    companion object {
        val Light = Palette(Color(0xFFF8F5EF), Color(0xFFFFFDF9), Color(0xFF1C1915), Color(0xFF6B6358), Color(0xFF8F5E1E), false)
        val Sepia = Palette(Color(0xFFF2E8D5), Color(0xFFF8F0E0), Color(0xFF2A2116), Color(0xFF6E5C45), Color(0xFF855114), false)
        val Dark = Palette(Color(0xFF121210), Color(0xFF1C1B18), Color(0xFFEBE6DD), Color(0xFFA39C90), Color(0xFFD8A24A), true)
    }
}

val BookmarkColor.swatch: Color
    get() = when (this) {
        BookmarkColor.GOLD -> Color(0xFFEBB833)
        BookmarkColor.GREEN -> Color(0xFF66BA6B)
        BookmarkColor.BLUE -> Color(0xFF42A6F5)
        BookmarkColor.PINK -> Color(0xFFED407A)
    }

/**
 * Iowan Old Style nema na Androidu, a `FontFamily.Serif` nije pouzdan: Motorola s font overlayem
 * (npr. Rookery) vraća sans-serif. Zato je Source Serif 4 (OFL, assets/licenses) ugrađen u APK.
 */
@OptIn(ExperimentalTextApi::class)
val ReadingFontFamily: FontFamily = FontFamily(
    listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold).flatMap { w ->
        listOf(
            Font(R.font.source_serif4, w, FontStyle.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(w.weight))),
            Font(R.font.source_serif4_italic, w, FontStyle.Italic, variationSettings = FontVariation.Settings(FontVariation.weight(w.weight))),
        )
    },
)

val LocalPalette = staticCompositionLocalOf { Palette.Light }

@Composable
fun BiblijaTheme(theme: ReaderTheme, content: @Composable () -> Unit) {
    val palette = when (theme) {
        ReaderTheme.SYSTEM -> if (isSystemInDarkTheme()) Palette.Dark else Palette.Light
        ReaderTheme.LIGHT -> Palette.Light
        ReaderTheme.SEPIA -> Palette.Sepia
        ReaderTheme.DARK -> Palette.Dark
    }
    val scheme = if (palette.isDark) {
        darkColorScheme(
            primary = palette.accent, onPrimary = palette.background,
            background = palette.background, onBackground = palette.text,
            surface = palette.background, onSurface = palette.text,
            surfaceContainer = palette.surface, surfaceVariant = palette.surface,
            surfaceContainerLowest = palette.surface, surfaceContainerLow = palette.surface,
            surfaceContainerHigh = palette.surface, surfaceContainerHighest = palette.surface,
            onSurfaceVariant = palette.muted, secondaryContainer = palette.accent.copy(alpha = 0.3f),
        )
    } else {
        lightColorScheme(
            primary = palette.accent, onPrimary = Color.White,
            background = palette.background, onBackground = palette.text,
            surface = palette.background, onSurface = palette.text,
            surfaceContainer = palette.surface, surfaceVariant = palette.surface,
            surfaceContainerLowest = palette.surface, surfaceContainerLow = palette.surface,
            surfaceContainerHigh = palette.surface, surfaceContainerHighest = palette.surface,
            onSurfaceVariant = palette.muted, secondaryContainer = palette.accent.copy(alpha = 0.18f),
        )
    }
    CompositionLocalProvider(LocalPalette provides palette) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
