import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Adresa Workera s /api/sync: -PbiblijaSyncBaseUrl=https://… ili biblija.syncBaseUrl u local.properties.
// Zadano je produkcijski Worker; korisnik je može promijeniti u Postavkama.
val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
val syncBaseUrl: String = (findProperty("biblijaSyncBaseUrl") as String?)
    ?: localProps.getProperty("biblija.syncBaseUrl")
    ?: "https://biblija.domovina.ai"

android {
    namespace = "hr.stepanic.biblija"
    compileSdk = 37

    defaultConfig {
        applicationId = "hr.stepanic.biblija365"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "SYNC_BASE_URL", "\"$syncBaseUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    androidResources {
        // biblija-mobile.db se kopira iz assets u filesDir; nekomprimirano je brže
        noCompress += "db"
    }
}

// Osvježi mobilnu bazu iz data/biblija.db prije svakog builda (preskače se ako je svježa).
val exportMobileDb = tasks.register<Exec>("exportMobileDb") {
    val repoRoot = rootDir.parentFile
    workingDir = repoRoot
    commandLine(
        "python3", "scripts/export_mobile_db.py", "--if-stale",
        "--out", File(projectDir, "src/main/assets/biblija-mobile.db").absolutePath,
    )
    inputs.file(File(repoRoot, "data/biblija.db")).optional()
    outputs.file(File(projectDir, "src/main/assets/biblija-mobile.db"))
}
tasks.named("preBuild") { dependsOn(exportMobileDb) }

dependencies {
    implementation(project(":core"))
    implementation(libs.sqlite.bundled)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
}
