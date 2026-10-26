package hr.stepanic.biblija

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.awaitCancellation
import hr.stepanic.biblija.ui.BiblijaApp
import hr.stepanic.biblija.ui.BiblijaTheme
import hr.stepanic.biblija.ui.LocalPalette

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            BiblijaTheme(vm.theme) {
                val palette = LocalPalette.current
                LaunchedEffect(palette) {
                    val bar = palette.background.toArgb()
                    enableEdgeToEdge(
                        statusBarStyle = if (palette.isDark) SystemBarStyle.dark(bar) else SystemBarStyle.light(bar, bar),
                        navigationBarStyle = if (palette.isDark) SystemBarStyle.dark(bar) else SystemBarStyle.light(bar, bar),
                    )
                }
                // kao visibilitychange na webu: sync kad se aplikacija vrati u prvi plan,
                // a dok je u prvom planu realtime veza na /api/live
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        vm.syncNow()
                        vm.setForeground(true)
                        try {
                            awaitCancellation()
                        } finally {
                            vm.setForeground(false)
                        }
                    }
                }
                BiblijaApp(vm)
            }
        }
    }
}
