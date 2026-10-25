package hr.stepanic.biblija.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.core.HrFold
import hr.stepanic.biblija.core.PlanDay
import hr.stepanic.biblija.core.ReadingPlan
import kotlinx.coroutines.launch

private enum class DayFilter(val label: String) { ALL("Svi"), TODO("Nepročitani"), DONE("Pročitani") }

/** Biblija 365: odabir plana, napredak, današnje čitanje i popis dana (stranica /plan/ na webu). */
@Composable
fun PlanScreen(vm: AppViewModel) {
    val plan = vm.plans.firstOrNull { it.id == vm.activePlanId } ?: vm.plans.firstOrNull() ?: return
    var filter by rememberSaveable { mutableStateOf(DayFilter.ALL) }
    var query by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    val days = vm.planDays(plan.id)
    val doneCount = days.count { vm.isDayDone(plan.id, it.day) }
    val next = days.firstOrNull { !vm.isDayDone(plan.id, it.day) }
    val q = HrFold.fold(query.trim())
    val visible = days.filter { d ->
        val done = vm.isDayDone(plan.id, d.day)
        when {
            filter == DayFilter.TODO && done -> false
            filter == DayFilter.DONE && !done -> false
            else -> q.isEmpty() || "dan ${d.day}".contains(q) || HrFold.fold(d.label).contains(q)
        }
    }
    val headerItems = 4

    ScreenScaffold(title = { Text("Biblija 365") }) { padding ->
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(padding), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item(key = "plan") {
                PlanPicker(vm, plan)
                Text(plan.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.padding(4.dp))
                LinearProgressIndicator(progress = { if (plan.daysCount > 0) doneCount.toFloat() / plan.daysCount else 0f }, modifier = Modifier.fillMaxWidth())
                Text(
                    "Pročitano: $doneCount / ${plan.daysCount} dana (${if (plan.daysCount > 0) doneCount * 100 / plan.daysCount else 0} %)",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            item(key = "today") {
                SectionTitle("Današnje čitanje")
                if (next != null) {
                    TodayCard(vm, plan, next)
                    TextButton(onClick = {
                        val idx = visible.indexOfFirst { it.day == next.day }
                        if (idx >= 0) scope.launch { listState.animateScrollToItem(idx + headerItems) }
                    }) { Text("Skoči na Dan ${next.day} u popisu") }
                } else {
                    Text("Čestitamo! Plan je u cijelosti pročitan.")
                }
            }
            item(key = "filters") {
                SectionTitle("Svi dani")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    DayFilter.entries.forEachIndexed { i, f ->
                        SegmentedButton(
                            selected = filter == f,
                            onClick = { filter = f },
                            shape = SegmentedButtonDefaults.itemShape(i, DayFilter.entries.size),
                        ) { Text(f.label) }
                    }
                }
            }
            item(key = "search") {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("Traži dan ili knjigu (npr. Dan 40, Iv)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                )
            }
            items(visible, key = { it.day }) { day ->
                PlanDayRow(vm, plan, day, isNext = day.day == next?.day)
            }
        }
    }
}

@Composable
private fun PlanPicker(vm: AppViewModel, plan: ReadingPlan) {
    var open by remember { mutableStateOf(false) }
    Surface(onClick = { open = true }, color = Color.Transparent) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
            Text(plan.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.UnfoldMore, contentDescription = "Promijeni plan")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (p in vm.plans) {
                DropdownMenuItem(
                    text = { Text("${p.title} (${p.daysCount})", fontWeight = if (p.id == plan.id) FontWeight.Bold else FontWeight.Normal) },
                    leadingIcon = if (p.id == plan.id) ({ Icon(Icons.Filled.Check, contentDescription = null) }) else null,
                    onClick = { vm.setActivePlan(p.id); open = false },
                )
            }
        }
    }
}

@Composable
private fun TodayCard(vm: AppViewModel, plan: ReadingPlan, day: PlanDay) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(12.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Dan ${day.day} od ${plan.daysCount}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Text(day.label, style = MaterialTheme.typography.titleLarge)
        Text("Ukupno ~${day.verseCount} redaka", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        ReadingChips(vm, plan, day)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { day.readings.firstOrNull()?.let { vm.openDay(day, plan.id, it) } }) {
                Icon(Icons.AutoMirrored.Outlined.MenuBook, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("Započni čitanje")
            }
            OutlinedButton(onClick = { vm.toggleDay(plan.id, day.day) }) {
                Icon(Icons.Filled.Check, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("Pročitano")
            }
        }
    }
}

@Composable
private fun ReadingChips(vm: AppViewModel, plan: ReadingPlan, day: PlanDay) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        itemsIndexed(day.readings) { _, reading ->
            AssistChip(onClick = { vm.openDay(day, plan.id, reading) }, label = { Text(reading.label) })
        }
    }
}

@Composable
private fun PlanDayRow(vm: AppViewModel, plan: ReadingPlan, day: PlanDay, isNext: Boolean) {
    val done = vm.isDayDone(plan.id, day.day)
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
        IconButton(onClick = { vm.toggleDay(plan.id, day.day) }) {
            Icon(
                if (done) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                contentDescription = if (done) "Dan ${day.day} pročitan" else "Označi Dan ${day.day} pročitanim",
                tint = if (done) Color(0xFF2E7D32) else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Dan ${day.day}", style = MaterialTheme.typography.titleSmall)
                if (isNext) {
                    Text(
                        "Danas",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier
                            .padding(start = 8.dp)
                            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.2f), RoundedCornerShape(50))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Text("${day.verseCount} redaka", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            ReadingChips(vm, plan, day)
        }
    }
}
