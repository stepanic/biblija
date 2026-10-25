package hr.stepanic.biblija.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.BuildConfig
import hr.stepanic.biblija.ReaderTheme
import hr.stepanic.biblija.ReadingMode
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Postavke čitanja, Sync kod + PIN, spremljeni profili, brisanje računa. */
@Composable
fun SettingsScreen(vm: AppViewModel) {
    ScreenScaffold(title = { Text("Postavke") }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item(key = "reading") { ReadingSettings(vm) }
            item(key = "sync") { SyncSettings(vm) }
            if (vm.savedProfiles.isNotEmpty()) {
                item(key = "profiles-title") { SectionTitle("Spremljeni profili na ovom uređaju") }
                items(vm.savedProfiles, key = { it.credentials.userKey }) { profile ->
                    Row(
                        Modifier.fillMaxWidth().clickable { vm.switchTo(profile) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("@${profile.credentials.userKey}", modifier = Modifier.weight(1f))
                        if (profile.credentials.userKey == vm.credentials?.userKey) {
                            Icon(Icons.Filled.Check, contentDescription = "Aktivan profil", tint = MaterialTheme.colorScheme.primary)
                        }
                        IconButton(onClick = { vm.removeProfile(profile) }) {
                            Icon(Icons.Outlined.Close, contentDescription = "Ukloni profil s uređaja")
                        }
                    }
                }
            }
            item(key = "server") {
                SectionTitle("Poslužitelj")
                OutlinedTextField(
                    value = vm.serverUrl,
                    onValueChange = vm::updateServerUrl,
                    placeholder = { Text("https://…") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Adresa Cloudflare Workera s /api/sync. Ista je kao adresa web aplikacije.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            item(key = "about") {
                SectionTitle("O aplikaciji")
                Text("Verzija ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium)
                Text("Verzija teksta ${vm.dataVersion}", style = MaterialTheme.typography.bodyMedium)
                Text("Tekst: Zagrebačka Biblija (KS)", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun ReadingSettings(vm: AppViewModel) {
    Column {
        SectionTitle("Čitanje")
        Text("Veličina slova: ${vm.fontSize.toInt()}")
        Slider(value = vm.fontSize, onValueChange = { vm.updateFontSize(it) }, valueRange = 14f..32f, steps = 17)
        Text("Prikaz", modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            ReadingMode.entries.forEachIndexed { i, m ->
                SegmentedButton(
                    selected = vm.readingMode == m,
                    onClick = { vm.updateReadingMode(m) },
                    shape = SegmentedButtonDefaults.itemShape(i, ReadingMode.entries.size),
                ) { Text(m.label) }
            }
        }
        Text("Tema", modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            ReaderTheme.entries.forEachIndexed { i, t ->
                SegmentedButton(
                    selected = vm.theme == t,
                    onClick = { vm.updateTheme(t) },
                    shape = SegmentedButtonDefaults.itemShape(i, ReaderTheme.entries.size),
                ) { Text(t.label, maxLines = 1) }
            }
        }
    }
}

@Composable
private fun SyncSettings(vm: AppViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var userKey by rememberSaveable { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle("Sinkronizacija")
        val creds = vm.credentials
        if (creds != null) {
            Text("Prijavljen: @${creds.userKey}", style = MaterialTheme.typography.titleSmall)
            Text("Zadnja sinkronizacija: ${formatTimestamp(vm.lastSyncedAt)}", style = MaterialTheme.typography.bodyMedium)
            Text("Pročitanih dana: ${vm.userData.completedDaysCount} • Oznaka i bilješki: ${vm.userData.activeBookmarks.size}", style = MaterialTheme.typography.bodyMedium)
            vm.syncError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { vm.syncNow() }, enabled = !vm.isSyncing) { Text("Sinkroniziraj sada") }
                if (vm.isSyncing) CircularProgressIndicator(Modifier.size(24.dp))
            }
            OutlinedButton(onClick = {
                copyToClipboard(context, "Biblija 365 Sync podaci:\nSync kod (korisničko ime): ${creds.userKey}\nPIN: ${creds.pin}")
                message = "Podaci za drugi uređaj su kopirani."
            }) { Text("Kopiraj podatke za drugi uređaj") }
            TextButton(onClick = { vm.signOut() }) { Text("Odjava s ovog uređaja", color = MaterialTheme.colorScheme.error) }
            Text(
                "Odjava briše napredak i oznake s ovog uređaja; na poslužitelju ostaju.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            HorizontalDivider()
            TextButton(onClick = { confirmDelete = true }) { Text("Trajno izbriši račun", color = MaterialTheme.colorScheme.error) }
        } else {
            OutlinedTextField(
                value = userKey,
                onValueChange = { userKey = it },
                label = { Text("Sync kod (korisničko ime)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = pin,
                onValueChange = { pin = it },
                label = { Text("PIN (barem 4 znamenke)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    enabled = !busy && vm.isServerConfigured,
                    onClick = {
                        busy = true
                        message = null
                        scope.launch {
                            try {
                                vm.signIn(userKey, pin)
                                pin = ""
                            } catch (e: Exception) {
                                message = e.message
                            } finally {
                                busy = false
                            }
                        }
                    },
                ) { Text("Poveži uređaj i sinkroniziraj") }
                if (busy) CircularProgressIndicator(Modifier.size(24.dp))
            }
            Text(
                if (vm.isServerConfigured) "Novi Sync kod stvara se automatski. Isti kod i PIN upiši na webu ili drugom uređaju."
                else "Prvo upiši adresu poslužitelja ispod.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }

    if (confirmDelete) {
        val key = vm.credentials?.userKey ?: ""
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Izbrisati račun @$key?") },
            text = { Text("Napredak u planovima i sve oznake brišu se s poslužitelja za sve uređaje. Ovo se ne može poništiti.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        message = try {
                            vm.deleteAccount()
                            null
                        } catch (e: Exception) {
                            e.message
                        }
                    }
                }) { Text("Izbriši račun i sve podatke", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Odustani") } },
        )
    }
}

private fun formatTimestamp(iso: String?): String {
    if (iso == null) return "—"
    return runCatching {
        DateTimeFormatter.ofPattern("d. M. yyyy. HH:mm", Locale.forLanguageTag("hr"))
            .withZone(ZoneId.systemDefault())
            .format(Instant.parse(iso))
    }.getOrDefault(iso)
}
