package hr.stepanic.biblija.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.core.Bookmark
import hr.stepanic.biblija.core.BookmarkColor
import hr.stepanic.biblija.core.ChapterRef

/** Moje oznake i bilješke (stranica /oznake/ na webu). Filtar: "all", "notes" ili boja. */
@Composable
fun BookmarksScreen(vm: AppViewModel) {
    var showLog by rememberSaveable { mutableStateOf(false) }
    if (showLog) {
        ReadingLogScreen(vm, onBack = { showLog = false })
        return
    }
    var filter by rememberSaveable { mutableStateOf("all") }
    val bookmarks = vm.userData.activeBookmarks.filter { b ->
        when (filter) {
            "all" -> true
            "notes" -> b.note.isNotEmpty()
            else -> b.bookmarkColor.raw == filter
        }
    }

    ScreenScaffold(
        title = { Text("Oznake") },
        actions = {
            IconButton(onClick = { showLog = true }) {
                Icon(Icons.Outlined.History, contentDescription = "Dnevnik čitanja")
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item(key = "filters") {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    modifier = Modifier.padding(bottom = 8.dp).bleed(16.dp),
                ) {
                    item { FilterChip(selected = filter == "all", onClick = { filter = "all" }, label = { Text("Sve") }) }
                    item { FilterChip(selected = filter == "notes", onClick = { filter = "notes" }, label = { Text("S bilješkom") }) }
                    items(BookmarkColor.entries) { c ->
                        FilterChip(
                            selected = filter == c.raw,
                            onClick = { filter = c.raw },
                            leadingIcon = { Box(Modifier.size(10.dp).background(c.swatch, CircleShape)) },
                            label = { Text(c.label) },
                        )
                    }
                }
            }
            if (bookmarks.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "Nema oznaka. Dodirni redak tijekom čitanja za označavanje bojom ili bilješku.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 32.dp),
                    )
                }
            }
            items(bookmarks, key = { it.key }) { bm ->
                BookmarkRow(
                    bm,
                    onOpen = { vm.open(ChapterRef(bm.bookOrder, bm.chapter), verse = bm.verse) },
                    onDelete = { vm.removeBookmark(bm.key) },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun BookmarkRow(bookmark: Bookmark, onOpen: () -> Unit, onDelete: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clickable(onClick = onOpen)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(bookmark.bookmarkColor.swatch, RoundedCornerShape(2.dp)))
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(
                "${bookmark.bookAbbr} ${bookmark.chapter},${bookmark.verse} — ${bookmark.bookTitle}",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                bookmark.text,
                style = TextStyle(fontFamily = ReadingFontFamily, fontSize = 16.sp, lineHeight = 24.sp),
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
            if (bookmark.note.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                    Icon(Icons.Outlined.Edit, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(bookmark.note, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Outlined.Delete, contentDescription = "Ukloni oznaku")
        }
    }
}
