# kotlinx.serialization: @Serializable klase iz :core
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class hr.stepanic.biblija.core.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class hr.stepanic.biblija.core.**$$serializer { *; }
