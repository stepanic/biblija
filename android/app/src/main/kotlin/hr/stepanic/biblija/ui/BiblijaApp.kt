package hr.stepanic.biblija.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import hr.stepanic.biblija.AppTab
import hr.stepanic.biblija.AppViewModel

private data class TabItem(val tab: AppTab, val label: String, val icon: ImageVector)

private val tabs = listOf(
    TabItem(AppTab.READER, "Čitaj", Icons.AutoMirrored.Outlined.MenuBook),
    TabItem(AppTab.PLAN, "Biblija 365", Icons.Outlined.CalendarMonth),
    TabItem(AppTab.SEARCH, "Pretraga", Icons.Outlined.Search),
    TabItem(AppTab.BOOKMARKS, "Oznake", Icons.Outlined.Bookmarks),
    TabItem(AppTab.SETTINGS, "Postavke", Icons.Outlined.Settings),
)

@Composable
fun BiblijaApp(vm: AppViewModel) {
    val error = vm.loadError
    if (error != null) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("Tekst Biblije nije dostupan: $error")
        }
        return
    }
    if (vm.repository == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }

    BackHandler(enabled = vm.selectedTab != AppTab.READER) { vm.selectedTab = AppTab.READER }

    Scaffold(
        bottomBar = {
            NavigationBar {
                for (item in tabs) {
                    NavigationBarItem(
                        selected = vm.selectedTab == item.tab,
                        onClick = { vm.selectedTab = item.tab },
                        icon = { Icon(item.icon, contentDescription = null) },
                        label = { Text(item.label, maxLines = 1) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (vm.selectedTab) {
                AppTab.READER -> ReaderScreen(vm)
                AppTab.PLAN -> PlanScreen(vm)
                AppTab.SEARCH -> SearchScreen(vm)
                AppTab.BOOKMARKS -> BookmarksScreen(vm)
                AppTab.SETTINGS -> SettingsScreen(vm)
            }
            vm.planCatchUp?.let { PlanCatchUpBanner(vm, it, Modifier.align(Alignment.BottomCenter)) }
        }
    }
}
