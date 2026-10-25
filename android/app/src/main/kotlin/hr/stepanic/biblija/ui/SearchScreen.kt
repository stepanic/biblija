package hr.stepanic.biblija.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.core.BibleReference
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.HrFold
import hr.stepanic.biblija.core.SearchHit
import hr.stepanic.biblija.core.SearchResult
import kotlinx.coroutines.delay

private val examples = listOf("ljubav", "\"u početku\"", "Duh Božji", "Iv 3,16", "Ps 23", "pastir")

/** Pretraga: lokalni SQLite FTS5 bez mreže, plus prepoznavanje kratica („Iv 3,16"). */
@Composable
fun SearchScreen(vm: AppViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var testament by rememberSaveable { mutableStateOf("") }
    var bookOrder by rememberSaveable { mutableStateOf<Int?>(null) }
    var result by remember { mutableStateOf(SearchResult.EMPTY) }
    var elapsedMs by remember { mutableDoubleStateOf(0.0) }
    var bookMenu by remember { mutableStateOf(false) }

    val reference = remember(query, vm.books) { BibleReference.parse(query, vm.books) }

    LaunchedEffect(query, testament, bookOrder) {
        delay(240) // debounce kao na webu
        val start = System.nanoTime()
        result = vm.search(query, testament.ifEmpty { null }, bookOrder)
        elapsedMs = (System.nanoTime() - start) / 1e6
    }

    ScreenScaffold(title = { Text("Pretraga") }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item(key = "input") {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                    trailingIcon = {
                        if (query.isNotEmpty()) IconButton(onClick = { query = "" }) { Icon(Icons.Filled.Clear, contentDescription = "Obriši") }
                    },
                    placeholder = { Text("Pojam, \"fraza\" ili kratica (Iv 3,16)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                    for ((value, label) in listOf("" to "Cijela Biblija", "SZ" to "SZ", "NZ" to "NZ")) {
                        FilterChip(
                            selected = testament == value,
                            onClick = {
                                testament = value
                                bookOrder?.let { bo -> if (value.isNotEmpty() && vm.book(bo)?.testament != value) bookOrder = null }
                            },
                            label = { Text(label) },
                        )
                    }
                    Column {
                        FilterChip(
                            selected = bookOrder != null,
                            onClick = { bookMenu = true },
                            label = { Text(bookOrder?.let { vm.book(it)?.abbr } ?: "Knjiga") },
                        )
                        DropdownMenu(expanded = bookMenu, onDismissRequest = { bookMenu = false }) {
                            DropdownMenuItem(text = { Text("Sve knjige") }, onClick = { bookOrder = null; bookMenu = false })
                            for (b in vm.books.filter { testament.isEmpty() || it.testament == testament }) {
                                DropdownMenuItem(text = { Text("${b.abbr} — ${b.title}") }, onClick = { bookOrder = b.order; bookMenu = false })
                            }
                        }
                    }
                }
            }

            if (reference != null) {
                item(key = "ref") {
                    FilledTonalButton(
                        onClick = { vm.open(ChapterRef(reference.book.order, reference.chapter), verse = reference.verse) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.MenuBook, contentDescription = null)
                        Text("  Otvori ${reference.label} — ${reference.book.title}")
                    }
                }
            }

            if (query.isBlank()) {
                item(key = "examples") {
                    SectionTitle("Primjeri")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (ex in examples.take(3)) AssistChip(onClick = { query = ex }, label = { Text(ex) })
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (ex in examples.drop(3)) AssistChip(onClick = { query = ex }, label = { Text(ex) })
                    }
                }
            } else {
                item(key = "status") {
                    Text(
                        "Pronađeno ${result.total} pogodaka (${"%.0f".format(elapsedMs)} ms)" +
                            if (result.total > result.hits.size) " — prikazano prvih ${result.hits.size}" else "",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
                items(result.hits, key = { it.key }) { hit ->
                    SearchHitRow(hit, query) { vm.open(ChapterRef(hit.bookOrder, hit.chapter), verse = hit.verse) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun SearchHitRow(hit: SearchHit, query: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp)) {
        Text(
            "${hit.bookAbbr} ${hit.chapter},${hit.verse} — ${hit.bookTitle}",
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(highlight(hit.text, query), style = TextStyle(fontFamily = ReadingFontFamily, fontSize = 16.sp, lineHeight = 24.sp))
    }
}

private fun highlight(text: String, query: String): AnnotatedString = buildAnnotatedString {
    append(text)
    for (r in HrFold.matchRanges(text, query)) {
        addStyle(SpanStyle(background = Color(0x66FFD54F), fontWeight = FontWeight.Bold), r.first, r.last + 1)
    }
}
