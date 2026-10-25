package hr.stepanic.biblija.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.BookmarkRemove
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.core.Book
import hr.stepanic.biblija.core.BookmarkColor
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.HrFold
import hr.stepanic.biblija.core.Verse

private enum class BookFilter(val label: String) { ALL("Sve"), OT("SZ"), NT("NZ"), DEUT("DK") }

/** Popis 73 knjige po kategorijama s filtrom SZ/NZ/DK i pretragom (ladica knjiga na webu). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookPickerSheet(vm: AppViewModel, current: ChapterRef, onDismiss: () -> Unit, onSelect: (ChapterRef) -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var filter by rememberSaveable { mutableStateOf(BookFilter.ALL) }
    var query by rememberSaveable { mutableStateOf("") }
    var chosen by remember { mutableStateOf<Book?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        val book = chosen
        if (book != null) {
            Column(Modifier.fillMaxHeight(0.92f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { chosen = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Natrag na knjige") }
                    Text(book.title, style = MaterialTheme.typography.titleMedium)
                }
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(56.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.padding(16.dp),
                ) {
                    items(vm.chapters(book), key = { it.chapter }) { ch ->
                        val isCurrent = book.order == current.bookOrder && ch.chapter == current.chapter
                        Surface(
                            onClick = { onSelect(ChapterRef(book.order, ch.chapter)) },
                            shape = RoundedCornerShape(10.dp),
                            color = if (isCurrent) MaterialTheme.colorScheme.primary.copy(alpha = 0.25f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
                            modifier = Modifier.heightIn(min = 48.dp).semantics {
                                contentDescription = if (ch.chapter == 0) "Proslov" else "Poglavlje ${ch.chapter}, ${ch.verseCount} redaka"
                            },
                        ) {
                            Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(vertical = 12.dp)) {
                                Text(ch.shortLabel, fontWeight = if (isCurrent) FontWeight.Bold else FontWeight.Normal)
                            }
                        }
                    }
                }
            }
            return@ModalBottomSheet
        }

        val q = HrFold.fold(query.trim())
        val filtered = vm.books.filter { b ->
            val tabOk = when (filter) {
                BookFilter.ALL -> true
                BookFilter.OT -> b.testament == "SZ"
                BookFilter.NT -> b.testament == "NZ"
                BookFilter.DEUT -> b.deuterocanonical
            }
            tabOk && (q.isEmpty() || HrFold.fold("${b.abbr} ${b.title} ${b.category} ${b.usfmId} ${b.nameEn}").contains(q))
        }
        val groups = filtered.groupBy { it.category }

        Column(Modifier.fillMaxHeight(0.92f).padding(horizontal = 16.dp)) {
            Text("Knjige Svetoga pisma", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Traži knjigu ili kraticu (Iv, Ps, Sir)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (f in BookFilter.entries) {
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }
            LazyColumn(Modifier.fillMaxWidth()) {
                for ((category, books) in groups) {
                    item(key = "cat-$category") { SectionTitle(category) }
                    items(books, key = { it.order }) { b ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { chosen = b }
                                .padding(vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(b.abbr, fontWeight = FontWeight.SemiBold, modifier = Modifier.width(56.dp))
                            Text(
                                b.title,
                                fontWeight = if (b.order == current.bookOrder) FontWeight.Bold else FontWeight.Normal,
                                modifier = Modifier.weight(1f),
                            )
                            Text("${b.chapterCount}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

/** Oznaka bojom, bilješka, kopiranje i dijeljenje retka (popover na webu). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerseSheet(vm: AppViewModel, ref: ChapterRef, verse: Verse, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val existing = vm.bookmark(ref, verse.verse)
    var note by rememberSaveable(verse.verse) { mutableStateOf(existing?.note ?: "") }
    var copied by remember { mutableStateOf(false) }
    val quote = "»${verse.text}« (${vm.book(ref.bookOrder)?.abbr ?: ""} ${ref.chapter},${verse.verse})"

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .navigationBarsPadding(),
        ) {
            Text("${vm.label(ref)},${verse.verse}", style = MaterialTheme.typography.titleMedium)
            Text(
                verse.text,
                style = TextStyle(fontFamily = ReadingFontFamily, fontSize = 17.sp, lineHeight = 26.sp),
                modifier = Modifier.padding(vertical = 12.dp),
            )

            SectionTitle("Boja oznake")
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp), modifier = Modifier.fillMaxWidth()) {
                for (c in BookmarkColor.entries) {
                    val isSelected = existing?.bookmarkColor == c
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(40.dp)
                            .background(c.swatch, CircleShape)
                            .then(if (isSelected) Modifier.border(3.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier)
                            .clickable { vm.saveBookmark(ref, verse, c, note) }
                            .semantics {
                                contentDescription = "${c.label} oznaka"
                                selected = isSelected
                            },
                    ) {
                        if (isSelected) Icon(Icons.Filled.Check, contentDescription = null, tint = Color.White)
                    }
                }
            }

            SectionTitle("Bilješka")
            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                placeholder = { Text("Osobna bilješka uz redak…") },
                minLines = 2,
                maxLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    vm.saveBookmark(ref, verse, existing?.bookmarkColor ?: BookmarkColor.GOLD, note)
                    onDismiss()
                },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            ) { Text(if (existing == null) "Spremi oznaku" else "Spremi bilješku") }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 12.dp)) {
                OutlinedButton(onClick = { copyToClipboard(context, quote); copied = true }) {
                    Icon(if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text(if (copied) "Kopirano" else "Kopiraj")
                }
                OutlinedButton(onClick = { shareText(context, quote) }) {
                    Icon(Icons.Outlined.Share, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Podijeli")
                }
            }
            if (existing != null) {
                TextButton(onClick = { vm.removeBookmark(existing.key); onDismiss() }) {
                    Icon(Icons.Outlined.BookmarkRemove, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(6.dp))
                    Text("Ukloni oznaku", color = MaterialTheme.colorScheme.error)
                }
            }
            Spacer(Modifier.size(16.dp))
        }
    }
}
