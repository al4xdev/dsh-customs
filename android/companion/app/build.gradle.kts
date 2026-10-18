import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}
// Optional public Companion Firebase identifiers, never a sender key. No google-services
// plugin/config is required, and the default APK makes no Firebase registration request.
val companionPushConfig = Properties().apply {
    val config = rootProject.file("companion-push.local.properties")
    if (config.isFile) config.inputStream().use { load(it) }
}
val pushKeys = listOf("projectId", "applicationId", "apiKey", "senderId")
val pushConfigured = companionPushConfig.getProperty("androidPackage") == "dev.alex.dsh.companion" &&
    pushKeys.all { !companionPushConfig.getProperty(it).isNullOrBlank() }
fun pushLiteral(key: String): String = "\"" + (if (pushConfigured) companionPushConfig.getProperty(key) else "")
    .replace("\\", "\\\\").replace("\"", "\\\"") + "\""
android {
    namespace = "dev.alex.dsh.companion"
    compileSdk = 34
    defaultConfig {
        applicationId = "dev.alex.dsh.companion"
        minSdk = 34
        targetSdk = 34
        versionCode = 17
        versionName = "0.17.0-history-page"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("boolean", "COMPANION_PUSH_CONFIGURED", pushConfigured.toString())
        buildConfigField("String", "COMPANION_PUSH_PROJECT_ID", pushLiteral("projectId"))
        buildConfigField("String", "COMPANION_PUSH_APPLICATION_ID", pushLiteral("applicationId"))
        buildConfigField("String", "COMPANION_PUSH_API_KEY", pushLiteral("apiKey"))
        buildConfigField("String", "COMPANION_PUSH_SENDER_ID", pushLiteral("senderId"))
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        abortOnError = true
        warningsAsErrors = true
        checkDependencies = true
        // This personal concept deliberately targets the owner's Android14.
        // Latest-version nudges are not correctness checks; newer Compose pins
        // can require a higher compileSdk. Keep all other lint findings fatal.
        disable += setOf("OldTargetApi", "GradleDependency")
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}
dependencies {
    implementation(project(":protocol"))
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Messaging only. No Analytics, Crashlytics, Firestore or Functions.
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    constraints {
        // Messaging brings an old Fragment transitively. Keep ActivityResult's
        // permission handling safe without raising the approved API34 target.
        implementation("androidx.fragment:fragment:1.6.2")
    }
    implementation("org.commonmark:commonmark:0.24.0")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.24.0")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.24.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    // The system text-selection toolbar is outside the Compose semantics tree.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
