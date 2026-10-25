// swift-tools-version:5.10
import PackageDescription

// Logika bez UI-ja: fold dijakritika, FTS upit, LWW merge, SQLite čitanje, sync klijent.
// `swift test` radi na macOS-u, bez simulatora.
let package = Package(
    name: "BiblijaKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "BiblijaKit", targets: ["BiblijaKit"]),
    ],
    targets: [
        .target(name: "BiblijaKit"),
        .testTarget(name: "BiblijaKitTests", dependencies: ["BiblijaKit"]),
    ]
)
