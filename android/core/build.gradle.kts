// Logika bez Androida: fold dijakritika, FTS upit, LWW merge, čitanje baze, sync klijent.
// `./gradlew :core:test` radi na JVM-u (BundledSQLiteDriver ima macOS/Linux nativne biblioteke).
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

// Bytecode za Java 17, da ga :app (D8) sigurno pojede; build radi na bilo kojem JDK ≥ 17.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.sqlite)
    api(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)

    testImplementation(kotlin("test"))
    testImplementation(libs.junit)
    testImplementation(libs.sqlite.bundled)
}

tasks.test {
    val repoRoot = rootDir.parentFile
    systemProperty("biblija.repoRoot", repoRoot.absolutePath)
    inputs.dir(File(repoRoot, "shared/test-vectors"))
}
