import BiblijaKit
import SwiftUI
import UIKit

/// Boje iz styles.css (:root, [data-theme="sepia"], [data-theme="dark"]).
struct Palette {
    let background: Color
    let text: Color
    let muted: Color
    let accent: Color
    let isDark: Bool

    static let light = Palette(background: Color(hex: 0xF8F5EF), text: Color(hex: 0x1C1915), muted: Color(hex: 0x6B6358), accent: Color(hex: 0x8F5E1E), isDark: false)
    static let sepia = Palette(background: Color(hex: 0xF2E8D5), text: Color(hex: 0x2A2116), muted: Color(hex: 0x6E5C45), accent: Color(hex: 0x855114), isDark: false)
    static let dark = Palette(background: Color(hex: 0x121210), text: Color(hex: 0xEBE6DD), muted: Color(hex: 0xA39C90), accent: Color(hex: 0xD8A24A), isDark: true)

    static func resolve(_ theme: ReaderTheme, scheme: ColorScheme) -> Palette {
        switch theme {
        case .system: scheme == .dark ? .dark : .light
        case .light: .light
        case .sepia: .sepia
        case .dark: .dark
        }
    }

    func highlight(_ color: BookmarkColor) -> Color {
        let alpha = isDark ? 0.25 : 0.32
        switch color {
        case .gold: return Color(red: 245 / 255, green: 194 / 255, blue: 66 / 255).opacity(alpha)
        case .green: return Color(red: 102 / 255, green: 187 / 255, blue: 106 / 255).opacity(alpha)
        case .blue: return Color(red: 66 / 255, green: 165 / 255, blue: 245 / 255).opacity(alpha)
        case .pink: return Color(red: 236 / 255, green: 64 / 255, blue: 122 / 255).opacity(alpha)
        }
    }
}

extension BookmarkColor {
    var swatch: Color {
        switch self {
        case .gold: Color(red: 0.92, green: 0.72, blue: 0.2)
        case .green: Color(red: 0.4, green: 0.73, blue: 0.42)
        case .blue: Color(red: 0.26, green: 0.65, blue: 0.96)
        case .pink: Color(red: 0.93, green: 0.25, blue: 0.48)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

extension ReaderTheme {
    /// Sepia i svijetla tema forsiraju svijetli izgled, tamna tamni; sustav prati iOS.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light, .sepia: .light
        case .dark: .dark
        }
    }
}

enum ReadingFont {
    /// Veličina iz postavki skalirana sistemskom veličinom teksta (Dynamic Type).
    static func size(_ base: Double) -> CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: base)
    }

    /// Iowan Old Style je prvi izbor i na webu (--font-reading).
    static func font(_ base: Double) -> Font {
        .custom("Iowan Old Style", size: size(base))
    }
}
