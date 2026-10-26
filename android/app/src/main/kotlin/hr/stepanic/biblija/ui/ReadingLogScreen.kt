package hr.stepanic.biblija.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.ReadingLogEntry
import hr.stepanic.biblija.core.Timestamp
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val dayFormat = DateTimeFormatter.ofPattern("EEEE, d. MMMM yyyy.", Locale.forLanguageTag("hr-HR"))
private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")

private fun minutes(e: ReadingLogEntry): Int {
    val s = Timestamp.parse(e.startedAt) ?: return 0
    val end = Timestamp.parse(e.endedAt) ?: return 0
    return maxOf(0, Math.round((end.toEpochMilli() - s.toEpochMilli()) / 60000.0).toInt())
}

private fun duration(min: Int) = if (min < 60) "$min min" else "${min / 60} h ${min % 60} min"

/** Dnevnik čitanja i mjesto linearnog čitanja (stranica /dnevnik/ na webu). Filtar: "all", "linear", "jump". */
@Composable
fun ReadingLogScreen(vm: AppViewModel, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val palette = LocalPalette.current
    var filter by rememberSaveable { mutableStateOf("all") }
    var showSet by remember { mutableStateOf(false) }
    val zone = ZoneId.systemDefault()

    val entries = vm.readingLog.filter {
        when (filter) {
            "linear" -> it.linear
            "jump" -> !it.linear
            else -> true
        }
    }
    val days = entries.groupBy { e -> Timestamp.parse(e.startedAt)?.atZone(zone)?.toLocalDate() }.filterKeys { it != null }

    ScreenScaffold(
        title = { Text("Dnevnik čitanja") },
        navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Natrag") }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item(key = "linear") {
                val cursor = vm.linear
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(palette.accent.copy(alpha = 0.08f))
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("REDOM SI STIGAO DO", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = palette.accent)
                    if (cursor != null) {
                        Text(placeLabel(cursor.label, cursor.verse), style = MaterialTheme.typography.titleMedium)
                        Button(onClick = { vm.openLinear() }, colors = ButtonDefaults.buttonColors(containerColor = palette.accent)) {
                            Text("Nastavi čitanje")
                            Spacer(Modifier.width(6.dp))
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null)
                        }
                    } else {
                        Text("Još nije postavljeno", style = MaterialTheme.typography.titleMedium)
                        Text("Otvori bilo koje poglavlje ili postavi mjesto ispod.", style = MaterialTheme.typography.bodySmall)
                    }
                    OutlinedButton(onClick = { showSet = true }) {
                        Icon(Icons.Outlined.Flag, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("Postavi mjesto od kojeg čitaš redom")
                    }
                }
            }
            item(key = "filters") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 12.dp)) {
                    FilterChip(selected = filter == "all", onClick = { filter = "all" }, label = { Text("Sve") })
                    FilterChip(selected = filter == "linear", onClick = { filter = "linear" }, label = { Text("Redom") })
                    FilterChip(selected = filter == "jump", onClick = { filter = "jump" }, label = { Text("Skokovi") })
                }
            }
            if (days.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (vm.readingLog.isEmpty()) "Dnevnik je prazan. Svako poglavlje koje otvoriš ovdje će se zapisati." else "Nema zapisa u odabranom filtru.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 32.dp),
                    )
                }
            }
            for ((day, list) in days) {
                item(key = "d$day") {
                    Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp)) {
                        Text(day!!.format(dayFormat).replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                        Text(duration(list.sumOf { minutes(it) }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider()
                }
                items(list, key = { it.id }) { e -> LogRow(e, zone) { vm.open(e) } }
            }
        }
    }

    if (showSet) SetLinearDialog(vm, onDismiss = { showSet = false })
}

@Composable
private fun LogRow(e: ReadingLogEntry, zone: ZoneId, onOpen: () -> Unit) {
    val min = minutes(e)
    val start = Timestamp.parse(e.startedAt)?.atZone(zone)?.format(timeFormat) ?: ""
    val end = Timestamp.parse(e.endedAt)?.atZone(zone)?.format(timeFormat) ?: ""
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 10.dp), verticalAlignment = Alignment.Top) {
        Text(
            if (min > 0) "$start–$end" else start,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(92.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(placeLabel(e.label, e.verse), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
            Text(
                listOfNotNull(if (e.linear) "Redom" else "Skok", if (min > 0) duration(min) else null, e.device.ifEmpty { null }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Ručni početak linearnog čitanja: knjiga, poglavlje i redak, bez listanja poglavlje po poglavlje. */
@Composable
private fun SetLinearDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    var ref by remember { mutableStateOf<ChapterRef?>(vm.linearRef) }
    var verseText by remember { mutableStateOf((vm.linear?.verse ?: 0).takeIf { it > 1 }?.toString() ?: "") }
    var showPicker by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Postavi mjesto") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Ako si čitao izvan aplikacije ili na starom profilu, odaberi gdje si stao i nastavi odande.", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { showPicker = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(ref?.let { vm.label(it) } ?: "Odaberi knjigu i poglavlje")
                }
                OutlinedTextField(
                    value = verseText,
                    onValueChange = { v -> verseText = v.filter { it.isDigit() }.take(3) },
                    label = { Text("Redak (neobavezno)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = ref != null, onClick = {
                ref?.let { vm.setLinear(it, verseText.toIntOrNull()?.takeIf { v -> v > 1 } ?: 0) }
                onDismiss()
            }) { Text("Postavi") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Odustani") } },
    )

    if (showPicker) {
        BookPickerSheet(vm, current = ref ?: vm.readerTarget.chapter, onDismiss = { showPicker = false }) { picked ->
            ref = picked
            verseText = ""
            showPicker = false
        }
    }
}
