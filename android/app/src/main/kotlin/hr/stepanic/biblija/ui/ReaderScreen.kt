package hr.stepanic.biblija.ui

import androidx.compose.foundation.background
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import hr.stepanic.biblija.AppViewModel
import hr.stepanic.biblija.PlanDayContext
import hr.stepanic.biblija.ReaderTheme
import hr.stepanic.biblija.ReadingMode
import hr.stepanic.biblija.TranslationLayout
import hr.stepanic.biblija.core.AltVerse
import hr.stepanic.biblija.core.ChapterRef
import hr.stepanic.biblija.core.Verse

/** Blokovi za prikaz, kao ChapterView.astro: naslovi, reference, odlomci ili pjesnički blokovi. */
sealed class ChapterBlock(val key: String) {
    class HeadingBlock(key: String, val level: String, val text: String) : ChapterBlock(key)
    class ReferenceBlock(key: String, val text: String) : ChapterBlock(key)
    class Prose(key: String, val verses: List<Verse>) : ChapterBlock(key)
    class Poetic(key: String, val verse: Verse) : ChapterBlock(key)
    /** Redak drugog prijevoda kad se prikazuje samostalno; ključ „v<N>" da didScroll zna redak. */
    class AltOnly(key: String, val alt: AltVerse) : ChapterBlock(key)
    /** Retci drugog prijevoda čiji broj KS nema (npr. Vulgatina podjela). */
    class AltExtra(key: String, val name: String, val verses: List<AltVerse>) : ChapterBlock(key)

    /** Redak bloka iz ključa („p12", „v12", „h12-0", „r12-0") */
    val firstVerse: Int
        get() = key.drop(1).takeWhile { it.isDigit() }.toIntOrNull() ?: 0

    val verseNumbers: List<Int>
        get() = when (this) {
            is Prose -> verses.map { it.verse }
            is Poetic -> listOf(verse.verse)
            is AltOnly -> listOf(alt.verse)
            else -> emptyList()
        }

    companion object {
        fun build(verses: List<Verse>, mode: ReadingMode): List<ChapterBlock> {
            val blocks = mutableListOf<ChapterBlock>()
            val paragraph = mutableListOf<Verse>()
            fun flush() {
                if (paragraph.isNotEmpty()) {
                    blocks.add(Prose("p${paragraph.first().verse}", paragraph.toList()))
                    paragraph.clear()
                }
            }
            verses.forEachIndexed { idx, v ->
                if (v.headings.isNotEmpty() || v.references.isNotEmpty() || v.isPoetic ||
                    mode == ReadingMode.VERSES || (v.paragraphStart && idx > 0)
                ) {
                    flush()
                }
                v.headings.forEachIndexed { i, h -> blocks.add(HeadingBlock("h${v.verse}-$i", h.level, h.text)) }
                v.references.forEachIndexed { i, r -> blocks.add(ReferenceBlock("r${v.verse}-$i", r)) }
                if (v.isPoetic) blocks.add(Poetic("v${v.verse}", v)) else paragraph.add(v)
            }
            flush()
            return blocks
        }
    }
}

@Composable
fun ReaderScreen(vm: AppViewModel) {
    val target = vm.readerTarget
    val ref = target.chapter
    val palette = LocalPalette.current
    var showPicker by rememberSaveable { mutableStateOf(false) }
    var selectedVerse by remember { mutableStateOf<Verse?>(null) }

    val verses = remember(ref) { vm.verses(ref) }
    val alt = remember(ref, vm.translation, vm.altTranslations) { vm.altChapter(ref) }
    val altParallel = alt.verses.isNotEmpty() && vm.translationLayout == TranslationLayout.PARALLEL
    val altByVerse = remember(alt) { alt.verses.associateBy { it.verse } }
    val blocks = remember(verses, vm.readingMode, alt, vm.translationLayout) {
        when {
            alt.verses.isEmpty() -> ChapterBlock.build(verses, vm.readingMode)
            vm.translationLayout == TranslationLayout.ONLY -> alt.verses.map { ChapterBlock.AltOnly("v${it.verse}", it) }
            else -> {
                // Usporedno: svaki redak KS-a svoj blok, da drugi prijevod stoji točno ispod njega (kao na webu)
                val ks = verses.map { it.verse }.toSet()
                val extra = alt.verses.filter { it.verse !in ks }
                ChapterBlock.build(verses, ReadingMode.VERSES) +
                    listOfNotNull(extra.takeIf { it.isNotEmpty() }?.let { ChapterBlock.AltExtra("xalt", vm.activeAltTranslation?.name ?: "", it) })
            }
        }
    }
    val listState = remember(ref) { androidx.compose.foundation.lazy.LazyListState() }

    LaunchedEffect(ref) { vm.didShow(ref) }
    LaunchedEffect(target, blocks) {
        val verse = target.verse ?: return@LaunchedEffect
        val idx = blocks.indexOfFirst { verse in it.verseNumbers }
        if (idx >= 0) listState.animateScrollToItem(idx + LEADING_ITEMS)
    }
    // Redak na vrhu ekrana za dnevnik čitanja i linearni kursor
    LaunchedEffect(listState, blocks) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { i ->
            vm.didScroll(blocks.getOrNull(i - LEADING_ITEMS)?.firstVerse ?: 0)
        }
    }

    ScreenScaffold(
        title = {
            TextButton(onClick = { showPicker = true }) {
                Text(vm.label(ref), style = MaterialTheme.typography.titleMedium, color = palette.text)
                Icon(Icons.Filled.ArrowDropDown, contentDescription = "Odaberi knjigu i poglavlje", tint = palette.text)
            }
        },
        navigationIcon = {
            Row {
                IconButton(onClick = { vm.neighbour(ref, -1)?.let { vm.open(it, keepDay = vm.activeDay != null) } }, enabled = vm.neighbour(ref, -1) != null) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Prethodno poglavlje")
                }
                IconButton(onClick = { vm.neighbour(ref, 1)?.let { vm.open(it, keepDay = vm.activeDay != null) } }, enabled = vm.neighbour(ref, 1) != null) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Sljedeće poglavlje")
                }
            }
        },
        actions = {
            TranslationMenu(vm)
            DisplayMenu(vm)
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().background(palette.background).padding(padding),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item(key = "linear") {
                val cursor = vm.linear
                if (vm.activeDay == null && cursor != null && !vm.isLinear(ref)) LinearReturnBanner(vm, cursor.label, cursor.verse, ref)
            }
            item(key = "banner") {
                vm.activeDay?.let { PlanDayBanner(vm, it, ref) }
            }
            item(key = "header") { ChapterHeader(vm, ref, alt.notice) }
            items(blocks, key = { it.key }) { block ->
                Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(horizontal = 20.dp)) {
                    BlockView(vm, ref, block, selectedVerse?.verse, if (altParallel) altByVerse else emptyMap()) { n ->
                        selectedVerse = verses.firstOrNull { it.verse == n }
                    }
                }
            }
            item(key = "footer") { ChapterFooter(vm, ref) }
        }
    }

    if (showPicker) {
        BookPickerSheet(vm, current = ref, onDismiss = { showPicker = false }) { picked ->
            showPicker = false
            vm.open(picked, keepDay = vm.activeDay != null)
        }
    }
    selectedVerse?.let { verse ->
        VerseSheet(vm, ref, verse, onDismiss = { selectedVerse = null })
    }
}

@Composable
private fun BlockView(
    vm: AppViewModel,
    ref: ChapterRef,
    block: ChapterBlock,
    selected: Int?,
    altByVerse: Map<Int, AltVerse>,
    onVerse: (Int) -> Unit,
) {
    val palette = LocalPalette.current
    val fs = vm.fontSize
    val readingStyle = TextStyle(fontFamily = ReadingFontFamily, fontSize = fs.sp, lineHeight = (fs * 1.6f).sp, color = palette.text)
    val altStyle = readingStyle.copy(fontSize = (fs * 0.92f).sp, lineHeight = (fs * 1.45f).sp, fontStyle = FontStyle.Italic, color = palette.muted)
    val altLines = block.verseNumbers.mapNotNull { altByVerse[it] }

    fun AnnotatedString.Builder.verseNumber(label: String) {
        withStyle(SpanStyle(fontSize = (fs * 0.58f).sp, fontWeight = FontWeight.SemiBold, color = palette.accent, baselineShift = BaselineShift(0.4f))) {
            append(label)
            append(' ')
        }
    }

    fun AnnotatedString.Builder.verseNumber(v: Verse): Unit = verseNumber(v.label)

    fun AnnotatedString.Builder.verseText(text: String, verse: Int) {
        val bm = vm.bookmark(ref, verse)
        val style = SpanStyle(
            background = bm?.let { palette.highlight(it.bookmarkColor) } ?: Color.Unspecified,
            textDecoration = if (selected == verse) TextDecoration.Underline else null,
        )
        withLink(LinkAnnotation.Clickable("v$verse", TextLinkStyles(SpanStyle())) { onVerse(verse) }) {
            withStyle(style) { append(text) }
        }
    }

    when (block) {
        is ChapterBlock.HeadingBlock -> Text(
            block.text,
            style = readingStyle.copy(
                fontSize = (if (block.level == "h2") fs * 1.25f else if (block.level == "h3") fs * 1.1f else fs).sp,
                fontWeight = if (block.level == "h4") FontWeight.SemiBold else FontWeight.Bold,
                color = if (block.level == "h2") palette.accent else palette.text,
            ),
            modifier = Modifier.padding(top = 18.dp, bottom = 6.dp).semantics { heading() },
        )
        is ChapterBlock.ReferenceBlock -> Text(
            block.text,
            style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic, color = palette.muted),
            modifier = Modifier.padding(bottom = 6.dp),
        )
        is ChapterBlock.Prose -> Text(
            buildAnnotatedString {
                block.verses.forEachIndexed { i, v ->
                    verseNumber(v)
                    verseText(v.text, v.verse)
                    if (i < block.verses.size - 1) append(' ')
                }
            },
            style = readingStyle,
            modifier = Modifier.padding(bottom = if (altLines.isNotEmpty()) 4.dp else if (vm.readingMode == ReadingMode.VERSES) 8.dp else 14.dp),
        )
        is ChapterBlock.Poetic -> Column(Modifier.padding(bottom = if (altLines.isNotEmpty()) 4.dp else 10.dp)) {
            block.verse.lines.forEachIndexed { idx, line ->
                Text(
                    buildAnnotatedString {
                        if (idx == 0) verseNumber(block.verse)
                        verseText(line, block.verse.verse)
                    },
                    style = readingStyle.copy(lineHeight = (fs * 1.45f).sp),
                    modifier = Modifier.padding(start = if (idx == 0) 0.dp else 18.dp),
                )
            }
        }
        is ChapterBlock.AltOnly -> Text(
            buildAnnotatedString {
                verseNumber(block.alt.verse.toString())
                append(block.alt.text)
            },
            style = readingStyle,
            modifier = Modifier.padding(bottom = 8.dp),
        )
        is ChapterBlock.AltExtra -> Column(Modifier.padding(top = 8.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "Retci koje KS nema pod istim brojem (${block.name}):",
                style = MaterialTheme.typography.bodySmall.copy(fontStyle = FontStyle.Italic, color = palette.muted),
            )
            block.verses.forEach { v ->
                Text(buildAnnotatedString { verseNumber(v.verse.toString()); append(v.text) }, style = altStyle)
            }
        }
    }
    // Drugi prijevod ispod retka KS-a: kurziv s crtom slijeva, kao .alt-verse na webu
    altLines.forEach { v ->
        Row(Modifier.padding(bottom = 10.dp).height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(palette.muted.copy(alpha = 0.35f)))
            Text(v.text, style = altStyle, modifier = Modifier.padding(start = 10.dp))
        }
    }
}

@Composable
private fun ChapterHeader(vm: AppViewModel, ref: ChapterRef, altNotice: String?) {
    val palette = LocalPalette.current
    val book = vm.book(ref.bookOrder) ?: return
    val chapters = vm.chapters(book)
    val info = chapters.firstOrNull { it.chapter == ref.chapter }
    Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp)) {
        Text(
            "${if (book.testament == "SZ") "Stari zavjet" else "Novi zavjet"} • ${book.category}",
            style = MaterialTheme.typography.labelMedium, color = palette.muted,
        )
        Text(
            book.title,
            style = TextStyle(fontFamily = ReadingFontFamily, fontSize = 30.sp, fontWeight = FontWeight.Bold, color = palette.text),
            modifier = Modifier.padding(vertical = 4.dp),
        )
        Text(
            if (ref.chapter == 0) "Proslov" else "${ref.chapter}. poglavlje" + (info?.let { " • ${it.verseCount} redaka" } ?: ""),
            style = MaterialTheme.typography.bodyMedium, color = palette.muted,
        )
        val stripState = rememberLazyListState()
        LaunchedEffect(ref) {
            val idx = chapters.indexOfFirst { it.chapter == ref.chapter }
            if (idx > 2) stripState.scrollToItem(idx - 2)
        }
        LazyRow(
            state = stripState,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            contentPadding = PaddingValues(horizontal = 20.dp),
            modifier = Modifier.padding(top = 10.dp).bleed(20.dp),
        ) {
            items(chapters, key = { it.chapter }) { ch ->
                val current = ch.chapter == ref.chapter
                Surface(
                    onClick = { vm.open(ChapterRef(book.order, ch.chapter), keepDay = vm.activeDay != null) },
                    shape = RoundedCornerShape(50),
                    color = if (current) palette.accent else palette.muted.copy(alpha = 0.12f),
                    contentColor = if (current) palette.background else palette.text,
                ) {
                    Text(
                        ch.shortLabel,
                        fontWeight = if (current) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        }
        // Izvor drugog prijevoda ili zašto ga za ovo poglavlje nema (#altNotice na webu)
        altNotice?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = palette.muted,
                modifier = Modifier
                    .padding(top = 14.dp)
                    .fillMaxWidth()
                    .background(palette.muted.copy(alpha = 0.1f), RoundedCornerShape(10.dp))
                    .padding(10.dp),
            )
        }
    }
}

/** Stavke LazyColumna prije blokova teksta: traka linearnog čitanja, traka plana, zaglavlje */
private const val LEADING_ITEMS = 3

/** „Izaija (Iz 12) · redak 5", kao placeLabel u public/astro-client.js */
fun placeLabel(label: String, verse: Int) = if (verse > 1) "$label · redak $verse" else label

/** Čitanje izvan reda: povratak na mjesto linearnog čitanja ili pomicanje kursora ovamo (traka na webu). */
@Composable
private fun LinearReturnBanner(vm: AppViewModel, label: String, verse: Int, current: ChapterRef) {
    val palette = LocalPalette.current
    Column(
        Modifier
            .widthIn(max = 720.dp)
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(palette.accent.copy(alpha = 0.08f))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("ČITAŠ IZVAN REDA", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = palette.accent)
        Text(
            buildAnnotatedString {
                append("Redom si stigao do ")
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(placeLabel(label, verse)) }
            },
            style = MaterialTheme.typography.bodyMedium,
            color = palette.text,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.openLinear() }, colors = ButtonDefaults.buttonColors(containerColor = palette.accent)) {
                Icon(Icons.AutoMirrored.Filled.Undo, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("Vrati se")
            }
            OutlinedButton(onClick = { vm.continueLinearHere(current) }) {
                Icon(Icons.Filled.SkipNext, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("Redom odavde")
            }
        }
    }
}

@Composable
private fun PlanDayBanner(vm: AppViewModel, context: PlanDayContext, current: ChapterRef) {
    val palette = LocalPalette.current
    val done = vm.isDayDone(context.planId, context.day.day)
    Column(
        Modifier
            .widthIn(max = 720.dp)
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(palette.accent.copy(alpha = 0.08f))
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Dan ${context.day.day}: ${context.day.label}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            IconButton(onClick = { vm.activeDay = null }, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "Sakrij traku plana")
            }
        }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            contentPadding = PaddingValues(horizontal = 12.dp),
            modifier = Modifier.bleed(12.dp),
        ) {
            items(context.day.readings.flatMap { it.chapters }) { ch ->
                AssistChip(
                    onClick = { vm.open(ch, keepDay = true) },
                    label = { Text(vm.label(ch), fontWeight = if (ch == current) FontWeight.Bold else FontWeight.Normal) },
                )
            }
        }
        Button(
            onClick = { vm.toggleDay(context.planId, context.day.day) },
            colors = ButtonDefaults.buttonColors(containerColor = if (done) Color(0xFF2E7D32) else palette.accent),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(if (done) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked, contentDescription = null)
            Spacer(Modifier.size(8.dp))
            Text(if (done) "Dan je označen pročitanim" else "Označi Dan ${context.day.day} pročitanim")
        }
    }
}

@Composable
private fun ChapterFooter(vm: AppViewModel, ref: ChapterRef) {
    val palette = LocalPalette.current
    Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(20.dp)) {
        HorizontalDivider(color = palette.muted.copy(alpha = 0.2f))
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for ((offset, title) in listOf(-1 to "← Prethodno", 1 to "Sljedeće →")) {
                val target = vm.neighbour(ref, offset)
                Column(
                    Modifier
                        .weight(1f)
                        .background(palette.muted.copy(alpha = if (target != null) 0.1f else 0f), RoundedCornerShape(12.dp))
                        .then(if (target != null) Modifier.clickable { vm.open(target, keepDay = vm.activeDay != null) } else Modifier)
                        .padding(12.dp),
                    horizontalAlignment = if (offset < 0) Alignment.Start else Alignment.End,
                ) {
                    if (target != null) {
                        Text(title, style = MaterialTheme.typography.labelSmall, color = palette.muted)
                        Text(vm.label(target), style = MaterialTheme.typography.titleMedium, color = palette.text)
                    }
                }
            }
        }
    }
}

@Composable
private fun TranslationMenu(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    val active = vm.activeAltTranslation
    IconButton(onClick = { open = true }) {
        Icon(
            Icons.Filled.Translate,
            contentDescription = "Prijevod: " + (active?.let { if (vm.translationLayout == TranslationLayout.PARALLEL) "KS i ${it.name}" else it.name } ?: "KS"),
            tint = if (active != null) LocalPalette.current.accent else LocalContentColor.current,
        )
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text("Kršćanska sadašnjost (KS)", fontWeight = if (active == null) FontWeight.Bold else FontWeight.Normal) },
            onClick = { vm.updateTranslation("ks"); open = false },
        )
        for (tr in vm.altTranslations) {
            DropdownMenuItem(
                text = { Text(tr.title, fontWeight = if (active?.slug == tr.slug) FontWeight.Bold else FontWeight.Normal) },
                onClick = { vm.updateTranslation(tr.slug); open = false },
            )
        }
        HorizontalDivider()
        for (layout in TranslationLayout.entries) {
            DropdownMenuItem(
                text = { Text(layout.label, fontWeight = if (vm.translationLayout == layout) FontWeight.Bold else FontWeight.Normal) },
                enabled = active != null,
                onClick = { vm.updateTranslationLayout(layout); open = false },
            )
        }
    }
}

@Composable
private fun DisplayMenu(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(Icons.Filled.TextFields, contentDescription = "Prikaz teksta")
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(text = { Text("Veća slova (${vm.fontSize.toInt()})") }, onClick = { vm.updateFontSize(vm.fontSize + 1) })
        DropdownMenuItem(text = { Text("Manja slova") }, onClick = { vm.updateFontSize(vm.fontSize - 1) })
        HorizontalDivider()
        for (mode in ReadingMode.entries) {
            DropdownMenuItem(
                text = { Text(mode.label, fontWeight = if (vm.readingMode == mode) FontWeight.Bold else FontWeight.Normal) },
                onClick = { vm.updateReadingMode(mode); open = false },
            )
        }
        HorizontalDivider()
        for (theme in ReaderTheme.entries) {
            DropdownMenuItem(
                text = { Text("Tema: ${theme.label}", fontWeight = if (vm.theme == theme) FontWeight.Bold else FontWeight.Normal) },
                onClick = { vm.updateTheme(theme); open = false },
            )
        }
    }
}
